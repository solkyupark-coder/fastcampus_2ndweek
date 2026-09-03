"use client";

import { useEffect, useRef, useState } from "react";
import type * as MLGL from "maplibre-gl";
import { downloadCSV, printSheet, type ExportInput } from "./export";
import { scaleReview, shrink, polyArea, mergeReview, zoneOf, floorPlan, bestFloors, unionParcels,
         footprintOf, farFor, parkingFor, parkingPlan, fireLane, BIZ_TYPES,
         northBoundary, sunlightFloorAt, FLOOR_H,
         sunlightFloor, SUNLIGHT_BASE, type SunRule,
         type Scale, type MergeParcel, type MergeReview } from "./scale";
import { fetchNeighborBuildings } from "./nbld";
import { walkRoutes, isochrone, isochroneEstimate, transitIsochrone, ISO_CONTOURS, ISO_LABEL,
         TRANSIT_CONTOURS, type Walk, type IsoMode } from "./walk";

// maplibre-gl는 CDN(layout.tsx의 <Script>)에서 로드한다.
// npm 번들 경로는 Next의 워커 처리 문제로 GeoJSON 소스가 렌더되지 않는다.
declare global {
  interface Window { maplibregl: typeof MLGL; __map?: MLGL.Map }
}

type Props = Record<string, string>;

const OSC: Record<string, string> = { 소형: "#2e7d32", 중형: "#f9a825", 대형: "#c62828", "": "#6b7280" };
const PIN_ID: Record<string, string> = { 소형: "pin-s", 중형: "pin-m", 대형: "pin-l", "": "pin-n" };

const LEGAL: Record<string, [number, number]> = {
  제1종전용주거: [50, 100], 제2종전용주거: [40, 120],
  제1종일반주거: [60, 150], 제2종일반주거: [60, 200], 제3종일반주거: [50, 250],
  준주거: [60, 400], 중심상업: [60, 1000], 일반상업: [60, 800], 근린상업: [60, 600], 준공업: [60, 400],
};
const legalOf = (uz: string) => {
  for (const k in LEGAL) if (uz && uz.includes(k)) return LEGAL[k];
  return null;
};
const nf = (n?: string) => (!n || n === "0.00" ? "–" : n);

const vworld = (path: string, params: Record<string, string>) =>
  `/api/vworld?path=${encodeURIComponent(path)}&${new URLSearchParams(params).toString()}`;

const BASES: Record<string, { tiles: string[]; attribution: string }> = {
  vbase: { tiles: ["/api/vworld-tile?t=Base&z={z}&y={y}&x={x}"], attribution: "© VWorld" },
  vsat: {
    tiles: ["/api/vworld-tile?t=Satellite&z={z}&y={y}&x={x}", "/api/vworld-tile?t=Hybrid&z={z}&y={y}&x={x}"],
    attribution: "© VWorld",
  },
  osm: { tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], attribution: "© OpenStreetMap" },
};

function baseStyle(key: string): MLGL.StyleSpecification {
  const b = BASES[key];
  const sources: Record<string, MLGL.SourceSpecification> = {};
  const layers: MLGL.LayerSpecification[] = [];
  b.tiles.forEach((url, i) => {
    sources["base" + i] = { type: "raster", tiles: [url], tileSize: 256, attribution: b.attribution };
    layers.push({ id: "base" + i, type: "raster", source: "base" + i });
  });
  return {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources,
    layers,
  };
}

const POI_KEYS: [string, string][] = [
  ["지하철역", "지하철역"], ["버스정류장", "버스정류장"], ["초등학교", "초등"],
  ["중고등학교", "중·고"], ["대학교", "대학"], ["어린이집", "어린이집"],
  ["유치원", "유치원"], ["병원", "병원"], ["공원", "공원"],
  ["대형점포", "대형점포"], ["주민센터", "주민센터"], ["공공도서관", "도서관"],
];

const STORE_COLOR: Record<string, string> = {
  음식: "#dc2626", 소매: "#2563eb", "수리·개인": "#7c3aed", "과학·기술": "#0891b2",
  "예술·스포츠": "#db2777", 부동산: "#65a30d", 숙박: "#ea580c", 교육: "#0d9488",
};

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** 폴리곤 중심(정점 평균) */
function centroidOf(g: GeoJSON.Geometry): [number, number] {
  let sx = 0, sy = 0, n = 0;
  const walkC = (a: unknown): void => {
    if (!Array.isArray(a)) return;
    if (typeof a[0] === "number") { sx += a[0] as number; sy += a[1] as number; n++; }
    else a.forEach(walkC);
  };
  walkC((g as { coordinates?: unknown }).coordinates);
  return n ? [sx / n, sy / n] : [126.98, 37.54];
}
const CAD_MIN_ZOOM = 16;

// ─── 핀 아이콘 (SVG → 이미지) ──────────────────────────────────────
const pinSVG = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="68" viewBox="0 0 26 34">
<path d="M13 1.2C6.9 1.2 2 6.1 2 12.2c0 8.3 11 20.6 11 20.6S24 20.5 24 12.2C24 6.1 19.1 1.2 13 1.2z"
 fill="${color}" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
<circle cx="13" cy="12" r="4.4" fill="#ffffff" fill-opacity="0.95"/></svg>`;

const loadImg = (svg: string): Promise<HTMLImageElement> =>
  new Promise((res, rej) => {
    const img = new Image();
    img.decoding = "sync";
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("pin svg decode failed"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });

/**
 * SVG를 캔버스로 래스터화해 ImageData로 넘긴다.
 * <img> 를 그대로 addImage 에 주면 디코드가 끝나기 전에 들어가
 * "InvalidStateError: The source image could not be decoded" 가 난다.
 */
async function svgToImageData(svg: string, w: number, h: number): Promise<ImageData> {
  const img = await loadImg(svg);
  if (typeof img.decode === "function") { try { await img.decode(); } catch { /* 일부 브라우저는 data URI에서 실패 */ } }
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

async function ensurePins(map: MLGL.Map) {
  for (const key of Object.keys(PIN_ID)) {
    const id = PIN_ID[key];
    if (map.hasImage(id)) continue;
    try {
      const data = await svgToImageData(pinSVG(OSC[key]), 52, 68);
      if (!map.hasImage(id)) map.addImage(id, data, { pixelRatio: 2 });
    } catch (e) {
      console.warn("핀 아이콘 생성 실패, 원형으로 대체", id, e);
    }
  }
}

type Selection = {
  p: Props; loading: boolean; pnu?: string;
  uz?: string; jimok?: string; area?: string; price?: string; shape?: string; road?: string;
};

export type Flr = { gb: string; no: number | null; purps: string; area: number | null };
export type Bld = {
  existing: null | {
    strct: string; roof: string; purps: string; etcPurps: string;
    platArea: number | null; archArea: number | null; totArea: number | null;
    bcRat: number | null; vlRat: number | null;
    grndFlr: number | null; ugrndFlr: number | null; heit: number | null;
    fmly: number | null; hhld: number | null; ho: number | null;
    pmsDay: string; useAprDay: string;
    pkngIn: number | null; pkngOut: number | null; elvt: number | null;
    flrs: Flr[];
  };
  permit: null | {
    status: string; sameAsExisting: boolean;
    name: string; gb: string; purps: string; strct: string; roof: string;
    platArea: number | null; archArea: number | null; totArea: number | null;
    bcRat: number | null; vlRat: number | null;
    fmly: number | null; hhld: number | null; pkng: number | null;
    jiyuk: string; guyuk: string;
    pmsDay: string; stcnsDay: string; useAprDay: string; crtnDay: string;
    flrs: Flr[];
  };
};

export type Stores = {
  radius: number; total: number; sampled: number;
  lcls: [string, number][]; mcls: [string, number][];
  points: { n: string; l: string; x: number; y: number }[];
};

export type Trades = {
  scope: "dong" | "sgg"; dong: string; months: number;
  n: number; nDong: number; nSgg: number;
  median: number; p25: number; p75: number; min: number; max: number;
  recent: { ym: string; dong: string; landUse: string; area: number; amount: number; unit: number; kind: string }[];
};


/** Polygon·MultiPolygon 을 "폴리곤 여러 장" 으로 통일한다.
 *  VWorld 필지(LP_PA_CBND_BUBUN)는 한 지번이 MultiPolygon 으로 오는 경우가 흔해서,
 *  Polygon 으로 단정하면 좌표가 한 단계 깊어져 면적이 0 이 되고 매스가 통째로 사라진다. */
function polysOf(g: GeoJSON.Geometry | null | undefined): GeoJSON.Position[][][] | null {
  if (!g) return null;
  if (g.type === "Polygon") return [g.coordinates];
  if (g.type === "MultiPolygon") return g.coordinates;
  return null;
}

export default function MapView() {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLGL.Map | null>(null);
  const dataRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const stateRef = useRef({
    gu: "", oscOn: {} as Record<string, boolean>,
    cadastral: false, usezone: false, vector: true, walk: true,
    isoMode: "pedestrian" as IsoMode | "transit" | "",
    showStores: true, mergeMode: false,
  });
  const moveBound = useRef(false);
  const cadKey = useRef("");
  const cadAbort = useRef<AbortController | null>(null);
  const walkAbort = useRef<AbortController | null>(null);
  const isoAbort = useRef<AbortController | null>(null);
  const tradeAbort = useRef<AbortController | null>(null);
  const storeAbort = useRef<AbortController | null>(null);
  const bldAbort = useRef<AbortController | null>(null);
  const nbldAbort = useRef<AbortController | null>(null);
  const lastCenter = useRef<[number, number] | null>(null);
  const pnuMap = useRef(new Map<string, Props>());
  // 폴리곤 여러 장. VWorld 필지는 MultiPolygon 으로 오는 경우가 흔하다
  const selPoly = useRef<GeoJSON.Position[][][] | null>(null);
  const lastUz = useRef("");

  const [ready, setReady] = useState(false);
  const [total, setTotal] = useState(0);
  const [count, setCount] = useState(0);
  const [gu, setGu] = useState("");
  const [gus, setGus] = useState<string[]>([]);
  const [base, setBase] = useState("vbase");
  const [cadastral, setCadastral] = useState(false);
  const [usezone, setUsezone] = useState(false);
  const [oscOn, setOscOn] = useState<Record<string, boolean>>({ 소형: true, 중형: true, 대형: true, "": true });
  const [sel, setSel] = useState<Selection | null>(null);
  const [vector, setVector] = useState(true);
  const [cadCount, setCadCount] = useState(0);
  const [cadLoading, setCadLoading] = useState(false);
  const [zoom, setZoom] = useState(10);
  const [walk, setWalk] = useState(true);
  const [walks, setWalks] = useState<Walk[] | "loading" | null>(null);
  const [isoMode, setIsoMode] = useState<IsoMode | "transit" | "">("pedestrian");
  const [transitInfo, setTransitInfo] = useState<{reached:number;boarded:number;nearest:string} | null>(null);
  const [isoLoading, setIsoLoading] = useState(false);
  const [trades, setTrades] = useState<Trades | "loading" | null>(null);
  const [stores, setStores] = useState<Stores | "loading" | null>(null);
  const [showStores, setShowStores] = useState(true);
  const [bld, setBld] = useState<Bld | "loading" | null>(null);
  const [mass3d, setMass3d] = useState(false);
  const [sunOn, setSunOn] = useState(true);
  const [sunRule, setSunRule] = useState<SunRule>("after");
  const [sunLost, setSunLost] = useState<number | null>(null);
  const [showCur, setShowCur] = useState(false);
  const [floors, setFloors] = useState<number | null>(null);
  const [bizId, setBizId] = useState("rent20");
  const [setback, setSetback] = useState(1);
  const [fpInfo, setFpInfo] = useState<{area:number;setback:number;limitedBy:string;bcrUsed:number} | null>(null);
  const [northInfo, setNorthInfo] = useState<{found:boolean;note:string;passed:{name:string;widthM:number}[]} | null>(null);
  const [nbldN, setNbldN] = useState(0);
  const [piloti, setPiloti] = useState(true);
  const [unitSize, setUnitSize] = useState(21);
  const [parkInfo, setParkInfo] = useState<ReturnType<typeof parkingPlan> | null>(null);
  const [fireInfo, setFireInfo] = useState<ReturnType<typeof fireLane> | null>(null);
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeList, setMergeList] = useState<(MergeParcel & { coords: GeoJSON.Position[][] })[]>([]);
  const [mergeUz, setMergeUz] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const mark = (k: string, on: boolean) => setBusy((b) => (b[k] === on ? b : { ...b, [k]: on }));

  stateRef.current = { gu, oscOn, cadastral, usezone, vector, walk, isoMode, showStores, mergeMode };

  // ─── 초기화 ──────────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current || !ref.current) return;
    let disposed = false;

    const boot = async () => {
      // CDN 스크립트 대기
      for (let i = 0; i < 100 && !window.maplibregl; i++) await new Promise((r) => setTimeout(r, 50));
      if (disposed || !ref.current || !window.maplibregl) return;
      const maplibregl = window.maplibregl;

      const map = new maplibregl.Map({
        container: ref.current,
        style: baseStyle("vbase"),
        center: [126.98, 37.54],
        zoom: 10,
      });
      mapRef.current = map;
      window.__map = map;
      map.addControl(new maplibregl.NavigationControl(), "top-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "metric" }));
      map.on("zoom", () => setZoom(map.getZoom()));

      map.once("load", async () => {
        const fc = (await fetch("/data/필지_현황.geojson").then((r) => r.json())) as GeoJSON.FeatureCollection;
        if (disposed) return;
        dataRef.current = fc;
        pnuMap.current = new Map(
          fc.features
            .map((f) => [(f.properties as Props).PNU, f.properties as Props] as const)
            .filter(([k]) => !!k)
        );
        setTotal(fc.features.length);
        setGus([...new Set(fc.features.map((f) => (f.properties as Props).gu))].sort());
        await buildLayers(map, fc);
        fitAll(map, fc);
        setReady(true);
      });
    };
    boot();

    return () => { disposed = true; mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  // ─── 레이어 구성 ─────────────────────────────────────────────────
  async function buildLayers(map: MLGL.Map, fc: GeoJSON.FeatureCollection) {
    await ensurePins(map);

    if (!map.getSource("parcels")) {
      map.addSource("parcels", { type: "geojson", data: fc });
      map.addSource("parcel-poly", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }
    if (!map.getSource("cad-vec")) {
      map.addSource("cad-vec", { type: "geojson", data: EMPTY });
    }
    if (!map.getSource("walk")) {
      map.addSource("walk", { type: "geojson", data: EMPTY });
      map.addSource("walk-poi", { type: "geojson", data: EMPTY });
      map.addSource("iso", { type: "geojson", data: EMPTY });
      map.addSource("stores", { type: "geojson", data: EMPTY });
      map.addSource("mass", { type: "geojson", data: EMPTY });
      map.addSource("nbld", { type: "geojson", data: EMPTY });
      map.addSource("merge", { type: "geojson", data: EMPTY });
    }

    // 합필 선택 필지
    if (!map.getLayer("merge-fill")) {
      map.addLayer({ id: "merge-fill", type: "fill", source: "merge",
        paint: { "fill-color": "#059669", "fill-opacity": 0.35 } });
      map.addLayer({ id: "merge-line", type: "line", source: "merge",
        paint: { "line-color": "#047857", "line-width": 2.5 } });
    }

    // 주변 상가업소 (업종 대분류별 색)
    if (!map.getLayer("stores-dot")) {
      map.addLayer({
        id: "stores-dot", type: "circle", source: "stores",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 2, 17, 4],
          "circle-color": ["match", ["get", "l"],
            "음식", "#dc2626", "소매", "#2563eb", "수리·개인", "#7c3aed",
            "과학·기술", "#0891b2", "예술·스포츠", "#db2777", "부동산", "#65a30d",
            "숙박", "#ea580c", "교육", "#0d9488", "#94a3b8"],
          "circle-opacity": 0.75,
        },
      });
    }

    // 도달권역(등시선) — 배경 바로 위
    if (!map.getLayer("iso-fill")) {
      map.addLayer({
        id: "iso-fill", type: "fill", source: "iso",
        paint: {
          "fill-color": ["match", ["get", "idx"], 0, "#ea580c", 1, "#fb923c", "#fed7aa"],
          "fill-opacity": ["match", ["get", "idx"], 0, 0.3, 1, 0.22, 0.16],
        },
      });
      map.addLayer({
        id: "iso-line", type: "line", source: "iso",
        paint: {
          "line-color": ["match", ["get", "idx"], 0, "#7c2d12", 1, "#c2410c", "#ea580c"],
          "line-width": ["match", ["get", "idx"], 0, 3, 1, 2.4, 2],
          "line-opacity": 0.95,
        },
      });
    }
    addOverlays(map);

    // 확대 시 필지 경계를 벡터로 (z≥16, VWorld 연속지적 GetFeature)
    if (!map.getLayer("cad-fill")) {
      map.addLayer({
        id: "cad-fill", type: "fill", source: "cad-vec",
        paint: { "fill-color": "#1f3a93", "fill-opacity": 0.05 },
      });
      map.addLayer({
        id: "cad-line", type: "line", source: "cad-vec",
        paint: {
          "line-color": "#334155",
          "line-width": ["interpolate", ["linear"], ["zoom"], 16, 0.8, 19, 2],
          "line-opacity": 0.85,
        },
      });
      map.addLayer({
        id: "cad-label", type: "symbol", source: "cad-vec",
        minzoom: 17,
        layout: {
          "text-field": ["get", "label"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 17, 9, 19, 12],
          "text-font": ["Noto Sans Regular"],
          "text-allow-overlap": false,
        },
        paint: { "text-color": "#1e293b", "text-halo-color": "#fff", "text-halo-width": 1.4 },
      });
    }

    if (!map.getLayer("poly-fill")) {
      map.addLayer({ id: "poly-fill", type: "fill", source: "parcel-poly", paint: { "fill-color": "#1f3a93", "fill-opacity": 0.18 } });
      map.addLayer({ id: "poly-line", type: "line", source: "parcel-poly", paint: { "line-color": "#1f3a93", "line-width": 2.5 } });
    }

    // 보행 경로 (정류장·역까지 실제 도보 네비게이션)
    if (!map.getLayer("walk-casing")) {
      map.addLayer({
        id: "walk-casing", type: "line", source: "walk",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 5, 18, 10], "line-opacity": 0.9 },
      });
      map.addLayer({
        id: "walk-line", type: "line", source: "walk",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["match", ["get", "kind"], "subway", "#7c3aed", "#0284c7"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 18, 6],
          "line-dasharray": [1.6, 1],
        },
      });
      map.addLayer({
        id: "walk-poi-dot", type: "circle", source: "walk-poi",
        paint: {
          "circle-radius": 7,
          "circle-color": ["match", ["get", "kind"], "subway", "#7c3aed", "#0284c7"],
          "circle-stroke-width": 2.5, "circle-stroke-color": "#fff",
        },
      });
      map.addLayer({
        id: "walk-poi-label", type: "symbol", source: "walk-poi",
        layout: {
          "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"],
          "text-size": 11, "text-offset": [0, 1.3], "text-anchor": "top", "text-allow-overlap": true,
        },
        paint: { "text-color": "#111", "text-halo-color": "#fff", "text-halo-width": 1.6 },
      });
    }

    // 법적 최대 매스 / 현재 건물 볼륨 — 층 단위 슬래브로 쌓아 층이 보이게 한다
    if (!map.getLayer("mass-cur")) {
      // 현재 건물 — 반투명 회색. 법정 최대와 겹치므로 옅게 깔고 뒤로 보낸다.
      map.addLayer({
        id: "mass-cur", type: "fill-extrusion", source: "mass",
        filter: ["==", ["get", "kind"], "cur"],
        paint: {
          "fill-extrusion-color": "#b45309",
          "fill-extrusion-height": ["get", "top"],
          "fill-extrusion-base": ["get", "base"],
          "fill-extrusion-opacity": 0.92,
        },
      });
      // 소방차 진입 통로 — 건물이 올라갈 수 없는 자리
      map.addLayer({
        id: "mass-fire", type: "fill", source: "mass",
        filter: ["==", ["get", "kind"], "fire"],
        paint: { "fill-color": "#dc2626", "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: "mass-fire-line", type: "line", source: "mass",
        filter: ["==", ["get", "kind"], "fire"],
        paint: { "line-color": "#dc2626", "line-width": 2, "line-dasharray": [2, 1.5] },
      });
      // 주변 건물 — VWorld GIS건물통합정보 발자국 × 층수. 회색 반투명 매스.
      map.addLayer({
        id: "nbld-3d", type: "fill-extrusion", source: "nbld",
        paint: {
          "fill-extrusion-color": "#cbd5e1",
          "fill-extrusion-height": ["get", "h"],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.55,
          "fill-extrusion-vertical-gradient": true,
        },
      });
      map.addLayer({
        id: "nbld-line", type: "line", source: "nbld",
        paint: { "line-color": "#64748b", "line-width": 0.8, "line-opacity": 0.7 },
      });

      // 법정 최대 매스 — 파란색, 진하게
      map.addLayer({
        id: "mass-3d", type: "fill-extrusion", source: "mass",
        filter: ["==", ["get", "kind"], "sel"],
        paint: {
          "fill-extrusion-color": "#1d4ed8",
          "fill-extrusion-height": ["get", "top"],
          "fill-extrusion-base": ["get", "base"],
          "fill-extrusion-opacity": 0.6,
        },
      });
      // 매스 외곽선 — 층 슬래브 테두리(평면 투영)
      map.addLayer({
        id: "mass-3d-line", type: "line", source: "mass",
        filter: ["==", ["get", "kind"], "sel"],
        paint: { "line-color": "#1e3a8a", "line-width": 1, "line-opacity": 0.5 },
      });
      map.addLayer({
        id: "mass-label", type: "symbol", source: "mass",
        filter: ["==", ["get", "tip"], true],
        layout: {
          "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"],
          "text-size": 11, "text-offset": [0, -0.4], "text-allow-overlap": true,
        },
        paint: { "text-color": "#1e3a8a", "text-halo-color": "#fff", "text-halo-width": 1.8 },
      });
    }

    // 낮은 줌 = 점, 높은 줌 = 핀 (크로스페이드)
    if (!map.getLayer("dots")) {
      map.addLayer({
        id: "dots", type: "circle", source: "parcels",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3, 12, 5],
          "circle-color": ["match", ["get", "OSC공법"], "소형", OSC["소형"], "중형", OSC["중형"], "대형", OSC["대형"], OSC[""]],
          "circle-stroke-width": 1, "circle-stroke-color": "#fff",
          "circle-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0.92, 13, 0],
          "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 12, 1, 13, 0],
        },
      });
    }
    if (!map.getLayer("pins")) {
      map.addLayer({
        id: "pins", type: "symbol", source: "parcels",
        layout: {
          "icon-image": ["match", ["get", "OSC공법"], "소형", PIN_ID["소형"], "중형", PIN_ID["중형"], "대형", PIN_ID["대형"], PIN_ID[""]],
          "icon-anchor": "bottom",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.55, 15, 0.85, 18, 1.1],
        },
        paint: { "icon-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0, 13, 1] },
      });
      for (const lyr of ["pins", "dots"]) {
        map.on("click", lyr, (e) => {
          if (stateRef.current.mergeMode) {
            const hit = map.queryRenderedFeatures(e.point, { layers: ["cad-fill"] })[0];
            if (hit) toggleMerge(hit as unknown as GeoJSON.Feature);
            return;
          }
          selectParcel(e.features![0] as unknown as GeoJSON.Feature);
        });
        map.on("mouseenter", lyr, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", lyr, () => { map.getCanvas().style.cursor = ""; });
      }
      // LH 목록에 없는 주변 필지도 클릭 조회
      map.on("click", "cad-fill", (e) => {
        const f = e.features![0] as unknown as GeoJSON.Feature;
        if (stateRef.current.mergeMode) { toggleMerge(f); return; }
        if (map.queryRenderedFeatures(e.point, { layers: ["pins", "dots"] }).length) return;
        selectNeighbor(map, f);
      });
      map.on("mouseenter", "cad-fill", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "cad-fill", () => { map.getCanvas().style.cursor = ""; });
    }
    if (!moveBound.current) {
      moveBound.current = true;
      map.on("moveend", () => refreshCadastral(map));
    }
    syncFilter(map);
    syncOverlayVis(map);
    refreshCadastral(map);
  }

  // ─── 화면 안 필지 경계를 벡터로 받아오기 ─────────────────────────
  async function refreshCadastral(map: MLGL.Map) {
    const src = map.getSource("cad-vec") as MLGL.GeoJSONSource | undefined;
    if (!src) return;

    if (!stateRef.current.vector || map.getZoom() < CAD_MIN_ZOOM) {
      if (cadKey.current !== "") { cadKey.current = ""; src.setData(EMPTY); setCadCount(0); }
      return;
    }
    const b = map.getBounds();
    const box = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(6));
    const key = box.join(",");
    if (key === cadKey.current) return;
    cadKey.current = key;

    cadAbort.current?.abort();
    const ac = new AbortController();
    cadAbort.current = ac;
    setCadLoading(true); mark("필지 경계", true);
    try {
      const r = await fetch(
        vworld("req/data", {
          service: "data", request: "GetFeature", data: "LP_PA_CBND_BUBUN",
          geomFilter: `BOX(${box[0]},${box[1]},${box[2]},${box[3]})`,
          geometry: "true", attribute: "true", crs: "EPSG:4326", size: "1000", format: "json",
        }),
        { signal: ac.signal }
      ).then((x) => x.json());
      const fc = r?.response?.result?.featureCollection as GeoJSON.FeatureCollection | undefined;
      if (fc?.features?.length) {
        // 도로·하천·구거·제방은 대지가 아니다 — 클릭 후보에서 뺀다.
        // (VWorld jibun 은 "1573-28대" 처럼 끝에 지목 한글이 붙는다)
        const NOT_SITE = /[도천구제]$/;
        fc.features = fc.features.filter((f) => {
          const jb = String((f.properties as Record<string, string>)?.jibun ?? "");
          return !NOT_SITE.test(jb.trim());
        });
        // 지번 라벨은 숫자만 (VWorld jibun엔 지목 한글이 섞여 있고 CDN 글리프에 한글이 없음)
        for (const f of fc.features) {
          const q = f.properties as Record<string, string>;
          const bon = (q.bonbun ?? "").replace(/\D/g, "");
          const bu = (q.bubun ?? "").replace(/\D/g, "");
          q.label = bon ? (bu && bu !== "0" ? `${bon}-${bu}` : bon) : "";
        }
        src.setData(fc);
      } else src.setData(EMPTY);
      setCadCount(fc?.features?.length ?? 0);
    } catch (e) {
      if ((e as Error).name !== "AbortError") console.warn("필지 경계 조회 실패", e);
    } finally {
      if (cadAbort.current === ac) setCadLoading(false);
      mark("필지 경계", false);
    }
  }

  function addOverlays(map: MLGL.Map) {
    const defs = [
      { id: "ov-cadastral", layer: "lp_pa_cbnd_bubun", opacity: 0.9 },
      { id: "ov-usezone", layer: "lt_c_uq111", opacity: 0.45 },
    ];
    for (const d of defs) {
      if (map.getSource(d.id)) continue;
      const url =
        `/api/vworld?path=req%2Fwms&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0` +
        `&LAYERS=${d.layer}&STYLES=${d.layer}&CRS=EPSG:3857&BBOX={bbox-epsg-3857}` +
        `&WIDTH=256&HEIGHT=256&FORMAT=image%2Fpng&TRANSPARENT=true`;
      map.addSource(d.id, { type: "raster", tiles: [url], tileSize: 256 });
      map.addLayer({ id: d.id, type: "raster", source: d.id, layout: { visibility: "none" }, paint: { "raster-opacity": d.opacity } });
    }
  }

  function syncFilter(map: MLGL.Map) {
    const { gu, oscOn } = stateRef.current;
    const ks = Object.keys(oscOn).filter((k) => oscOn[k]);
    const f: MLGL.FilterSpecification = ["all",
      ["in", ["get", "OSC공법"], ["literal", ks]],
      gu ? ["==", ["get", "gu"], gu] : ["literal", true],
    ];
    for (const l of ["pins", "dots"]) if (map.getLayer(l)) map.setFilter(l, f);
    const fc = dataRef.current;
    if (fc) setCount(fc.features.filter(
      (x) => ks.includes((x.properties as Props)["OSC공법"]) && (!gu || (x.properties as Props).gu === gu)
    ).length);
  }

  function syncOverlayVis(map: MLGL.Map) {
    const { cadastral, usezone } = stateRef.current;
    if (map.getLayer("ov-cadastral")) map.setLayoutProperty("ov-cadastral", "visibility", cadastral ? "visible" : "none");
    if (map.getLayer("ov-usezone")) map.setLayoutProperty("ov-usezone", "visibility", usezone ? "visible" : "none");
  }

  function fitAll(map: MLGL.Map, fc: GeoJSON.FeatureCollection) {
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    for (const f of fc.features) {
      const [x, y] = (f.geometry as GeoJSON.Point).coordinates;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    map.fitBounds([[minX, minY], [maxX, maxY]], { padding: { top: 40, right: 40, bottom: 40, left: 320 }, duration: 0 });
  }

  // ─── 합필 검토 ──────────────────────────────────────────────────
  function toggleMerge(feat: GeoJSON.Feature) {
    const fp = (feat.properties ?? {}) as Record<string, string>;
    const pnu = fp.pnu || fp.PNU || "";
    if (!pnu) return;
    const coords = (feat.geometry as GeoJSON.Polygon).coordinates;
    setMergeList((prev) => {
      const i = prev.findIndex((x) => x.pnu === pnu);
      if (i >= 0) return prev.filter((_, k) => k !== i);
      return [...prev, { pnu, addr: fp.addr || fp.jibun || pnu, area: Math.round(polyArea(coords)), coords }];
    });
  }

  // 합필 대상의 용도지역 — 첫 필지 기준으로 한 번만 조회
  useEffect(() => {
    const first = mergeList[0];
    if (!first) { setMergeUz(""); return; }
    if (lastUz.current) { setMergeUz(lastUz.current); return; }
    let dead = false;
    loadLand(first.pnu).then((land) => {
      if (dead) return;
      const uz = pick(land).uz;
      if (uz) { lastUz.current = uz; setMergeUz(uz); }
    });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergeList.length ? mergeList[0].pnu : ""]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getSource("merge")) return;
    // 합쳐진 대지 경계를 보여준다 (필지 사이 경계선은 사라진다)
    const merged = mergeList.length >= 2
      ? unionParcels(mergeList.map((x) => x.coords))
      : mergeList.map((x) => x.coords);
    (map.getSource("merge") as MLGL.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: merged.map((poly, i) => ({
        type: "Feature", properties: { i },
        geometry: { type: "Polygon", coordinates: poly },
      })),
    });
  }, [mergeList, ready]);

  // ─── 3D 최대 매스 ───────────────────────────────────────────────
  // 선택한 필지에 법정 최대 볼륨을 층 단위 슬래브로 쌓는다.
  // 용도지역은 그 필지를 조회했을 때 받은 값을 쓴다.
  // 겹쳐보기 = VWorld 3D 건물(3D Tiles/b3dm)을 실제 형상으로 얹는다.
  // 대장 값으로 만든 근사 상자 대신 진짜 건물이 보인다.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const on = showCur && mass3d;
    const src = map.getSource("nbld") as MLGL.GeoJSONSource | undefined;
    const center = (selPoly.current?.[0]
      ? centroidOf({ type: "Polygon", coordinates: selPoly.current[0] } as GeoJSON.Geometry)
      : lastCenter.current) as [number, number] | undefined;

    if (!on || !src || !center) {
      src?.setData(EMPTY);
      setNbldN(0);
    } else {
      nbldAbort.current?.abort();
      const ac = new AbortController();
      nbldAbort.current = ac;
      setNbldN(-1); // 로딩
      fetchNeighborBuildings(center, ac.signal)
        .then((fc) => {
          if (ac.signal.aborted) return;
          src.setData(fc);
          setNbldN(fc.features.length);
        })
        .catch((err) => {
          if ((err as Error).name !== "AbortError") { console.warn("주변 건물 실패", err); setNbldN(0); }
        });
    }
    // 주변 건물이 보이면 법정 최대 매스는 살짝만 옅게(파란색은 유지)
    if (map.getLayer("mass-3d")) {
      map.setPaintProperty("mass-3d", "fill-extrusion-opacity", on ? 0.5 : 0.6);
    }
    if (map.getLayer("mass-cur")) {
      map.setPaintProperty("mass-cur", "fill-extrusion-opacity", 0);
    }
  }, [showCur, mass3d, sel, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getSource("mass")) return;
    const src = map.getSource("mass") as MLGL.GeoJSONSource;
    if (!mass3d) { src.setData(EMPTY); return; }

    const uz = lastUz.current;
    const zone = zoneOf(uz);
    const b0 = bld && bld !== "loading" ? bld : null;
    const area0 = Number(sel?.area) || b0?.existing?.platArea || 0;
    const feats: GeoJSON.Feature[] = [];

    let cutArea = 0;   // 일조로 깎인 바닥면적 합계(㎡)
    const biz = BIZ_TYPES.find((t) => t.id === bizId) ?? BIZ_TYPES[0];

    // 화면 안 필지들 — 정북 인접대지경계선 자동 판정에 쓴다
    const neighbors = map.querySourceFeatures("cad-vec")
      .filter((f) => (f.geometry as GeoJSON.Polygon)?.type === "Polygon")
      .map((f) => ({
        poly: (f.geometry as GeoJSON.Polygon).coordinates as GeoJSON.Position[][],
        jibun: String((f.properties as Record<string, string>)?.jibun ?? ""),
      }));
    let north: ReturnType<typeof northBoundary> | null = null;

    // 층 슬래브를 쌓는다. 바닥면(footprint)은 이미 offset 된 것을 받는다.
    const stack = (
      foot: GeoJSON.Position[][][], nFloors: number, kind: string, label?: string
    ) => {
      const full = foot.reduce((t, p) => t + polyArea(p), 0);
      for (let i = 0; i < nFloors; i++) {
        const topH = (i + 1) * FLOOR_H;
        // 필로티(1층)는 기둥만 있는 열린 층. 상자를 그리지 않고 비운다.
        if (piloti && i === 0) continue;
        for (const poly of foot) {
          let g: GeoJSON.Position[][] | null = poly;
          if (sunOn && north) {
            g = sunlightFloorAt(poly, topH, sunRule, north.boundaryY);
            if (!g) continue;
          }
          feats.push({
            type: "Feature",
            properties: { kind, base: i * FLOOR_H, top: topH - 0.25 },
            geometry: { type: "Polygon", coordinates: g },
          });
        }
        if (sunOn && north) {
          const kept = foot.reduce((t, poly) => {
            const g = sunlightFloorAt(poly, topH, sunRule, north!.boundaryY);
            return t + (g ? polyArea(g) : 0);
          }, 0);
          cutArea += Math.max(0, full - kept);
        }
      }
      if (label && foot.length) {
        feats.push({
          type: "Feature",
          properties: { kind, base: 0, top: 0, tip: true, label },
          geometry: { type: "Point", coordinates: centroidOf({ type: "Polygon", coordinates: foot[0] } as GeoJSON.Geometry) },
        });
      }
    };

    /** 대지(여러 폴리곤) → offset 건축면적 → 층수 → 매스 */
    const build = (site: GeoJSON.Position[][][], z: NonNullable<ReturnType<typeof zoneOf>>, tag: string) => {
      const siteArea = site.reduce((t, p) => t + polyArea(p), 0);
      if (!(siteArea > 0)) return;

      // 0) 정북 인접대지경계선 자동 판정 (도로·공원이 끼면 반대편으로)
      north = northBoundary(site, neighbors);
      setNorthInfo(north);

      // 1) 대지 경계에서 이격 → 건축면적
      const fp = footprintOf(site, siteArea, z.bcr, setback);
      setFpInfo({ area: fp.area, setback: fp.setback, limitedBy: fp.limitedBy, bcrUsed: fp.bcrUsed });
      if (!fp.coords.length) return;

      // 2) 용적률(사업유형 반영) ÷ 건축면적 → 층수
      //    필로티 1층은 바닥면적에 산입하지 않으므로 주거층만 용적률에 센다.
      const far = farFor(z, biz);
      const maxTot = siteArea * far / 100;
      const liveMax = Math.max(1, Math.floor(maxTot / fp.area));      // 주거층 수
      const nLive = floors ?? liveMax;
      const n = nLive + (piloti ? 1 : 0);                             // 총 층수
      const totArea = Math.min(maxTot, fp.area * nLive);              // 용적률 산정 연면적

      // 3) 세대수 → 법정 주차 → 필로티로 감당되는지
      const units = Math.floor((totArea * 0.8) / unitSize);
      const pk = parkingPlan(biz, fp.area, totArea, units, unitSize, piloti);
      setParkInfo(pk);

      // 소방차 진입 — 접도 조건으로 판정
      const frontM = Math.sqrt(siteArea);   // 대지 한 변 근사
      setFireInfo(fireLane(totArea, String(sel?.p?.["도로접면"] ?? sel?.road ?? ""), frontM));

      stack(fp.coords, n, "sel",
        `${tag}${piloti ? `필로티+${nLive}층` : `${n}층`} · ${(n * FLOOR_H).toFixed(0)}m · ` +
        `연면적 ${Math.round(totArea).toLocaleString()}㎡ · 용적 ${Math.round(totArea / siteArea * 100)}%`);
    };

    if (mergeMode && mergeList.length >= 2) {
      const z = zoneOf(mergeUz || lastUz.current);
      if (z) {
        const merged = unionParcels(mergeList.map((x) => x.coords));
        const sumArea = merged.reduce((t, p) => t + polyArea(p), 0);
        build(merged, z, `합필 ${mergeList.length}필지 · ${Math.round(sumArea).toLocaleString()}㎡ · `);
      }
      src.setData({ type: "FeatureCollection", features: feats });
      setSunLost(sunOn ? Math.round(cutArea) : null);
      if (feats.length && map.getPitch() < 20) map.easeTo({ pitch: 55, duration: 700 });
      return;
    }

    if (zone && selPoly.current) build(selPoly.current, zone, "");

    // 선택 필지의 현재 건물 — 대장 층수만큼
    const b = bld && bld !== "loading" ? bld : null;
    const e = b?.existing;
    const area = Number(sel?.area) || e?.platArea || 0;
    if (showCur && e && selPoly.current && area > 0 && e.archArea) {
      const gf = e.grndFlr ?? Math.max(1, Math.round((e.totArea ?? 0) / e.archArea));
      const h = e.heit ?? gf * FLOOR_H;
      const per = h / Math.max(1, gf);
      for (const poly of selPoly.current) {
        const foot = shrink(poly, e.archArea / area);
        for (let i = 0; i < gf; i++) {
          // 이미 서 있는 건물이므로 일조 사선은 적용하지 않는다
          feats.push({
            type: "Feature",
            properties: { kind: "cur", base: i * per, top: (i + 1) * per - 0.2 },
            geometry: { type: "Polygon", coordinates: foot },
          });
        }
      }
    }

    src.setData({ type: "FeatureCollection", features: feats });
    setSunLost(sunOn ? Math.round(cutArea) : null);
    if (feats.length && map.getPitch() < 20) map.easeTo({ pitch: 55, duration: 700 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mass3d, sel, bld, sunOn, sunRule, showCur, floors, bizId, setback, piloti, unitSize, mergeMode, mergeList, mergeUz, ready]);

  useEffect(() => { const m = mapRef.current; if (m && ready) syncFilter(m); }, [gu, oscOn, ready]);
  useEffect(() => { const m = mapRef.current; if (m && ready) syncOverlayVis(m); }, [cadastral, usezone, ready]);
  useEffect(() => { const m = mapRef.current; if (m && ready) { cadKey.current = ""; refreshCadastral(m); } }, [vector, ready]);
  useEffect(() => {
    if (!mapRef.current || !ready) return;
    if (lastCenter.current) loadWalk(lastCenter.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walk, ready]);
  useEffect(() => {
    if (!mapRef.current || !ready) return;
    if (lastCenter.current) loadStores(lastCenter.current);
    else if (!showStores) (mapRef.current.getSource("stores") as MLGL.GeoJSONSource)?.setData(EMPTY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showStores, ready]);
  useEffect(() => {
    if (!mapRef.current || !ready) return;
    if (lastCenter.current) loadIso(lastCenter.current);
    else if (!isoMode) (mapRef.current.getSource("iso") as MLGL.GeoJSONSource)?.setData(EMPTY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isoMode, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setStyle(baseStyle(base), { diff: false });
    map.once("styledata", () => { buildLayers(map, dataRef.current!); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  // ─── 건축물대장 + 건축인허가 (건축HUB) ──────────────────────────
  async function loadBuilding(pnu: string) {
    bldAbort.current?.abort();
    const ac = new AbortController();
    bldAbort.current = ac;
    if (!/^\d{19}$/.test(pnu)) { setBld(null); return; }
    setBld("loading"); mark("건축물대장·인허가", true);
    try {
      const j = (await fetch(`/api/building?pnu=${pnu}`, { signal: ac.signal }).then((r) => r.json())) as Bld;
      if (!ac.signal.aborted) setBld(j.existing || j.permit ? j : null);
    } catch (e) {
      if ((e as Error).name !== "AbortError") { console.warn("건축물 조회 실패", e); setBld(null); }
    } finally { mark("건축물대장·인허가", false); }
  }

  // ─── 주변 상권 (소상공인시장진흥공단) ────────────────────────────
  async function loadStores(center: [number, number]) {
    const map = mapRef.current!;
    storeAbort.current?.abort();
    const ac = new AbortController();
    storeAbort.current = ac;
    const src = map.getSource("stores") as MLGL.GeoJSONSource | undefined;

    if (!stateRef.current.showStores) { src?.setData(EMPTY); setStores(null); return; }
    setStores("loading"); mark("상권", true);
    try {
      const r = await fetch(`/api/stores?cx=${center[0]}&cy=${center[1]}&radius=500`, { signal: ac.signal });
      const j = (await r.json()) as Stores;
      if (ac.signal.aborted) return;
      src?.setData({
        type: "FeatureCollection",
        features: j.points.map((p) => ({
          type: "Feature", properties: { l: p.l, n: p.n },
          geometry: { type: "Point", coordinates: [p.x, p.y] },
        })),
      });
      setStores(j);
    } catch (e) {
      if ((e as Error).name !== "AbortError") { console.warn("상권 조회 실패", e); setStores(null); }
    } finally { mark("상권", false); }
  }

  // ─── 인근 토지 실거래 (국토부) ───────────────────────────────────
  async function loadTrades(pnu: string, dong: string) {
    tradeAbort.current?.abort();
    const ac = new AbortController();
    tradeAbort.current = ac;
    const lawd = pnu.slice(0, 5);
    if (!/^\d{5}$/.test(lawd)) { setTrades(null); return; }
    setTrades("loading"); mark("토지 실거래", true);
    try {
      const r = await fetch(
        `/api/trades?lawd=${lawd}&dong=${encodeURIComponent(dong)}&months=18`,
        { signal: ac.signal }
      );
      const j = await r.json();
      if (!ac.signal.aborted) setTrades(j?.n ? (j as Trades) : null);
    } catch (e) {
      if ((e as Error).name !== "AbortError") { console.warn("실거래 조회 실패", e); setTrades(null); }
    } finally { mark("토지 실거래", false); }
  }

  // ─── 도달권역(등시선) ────────────────────────────────────────────
  async function loadIso(center: [number, number]) {
    const map = mapRef.current!;
    const src = map.getSource("iso") as MLGL.GeoJSONSource | undefined;
    if (!src) return;
    isoAbort.current?.abort();
    const mode = stateRef.current.isoMode;
    if (!mode) { src.setData(EMPTY); setIsoLoading(false); return; }

    const ac = new AbortController();
    isoAbort.current = ac;
    setIsoLoading(true); mark("도달권역", true);
    setTransitInfo(null);
    try {
      if (mode === "transit") {
        const t = await transitIsochrone(center, ac.signal);
        if (ac.signal.aborted) return;
        src.setData(t?.fc ?? EMPTY);
        if (t) setTransitInfo({ reached: t.reached, boarded: t.boarded, nearest: t.nearest });
        return;
      }
      // 원형 대략치를 즉시 깔고(네트워크 0), 도로망 결과가 오면 교체한다.
      src.setData(isochroneEstimate(center, mode));
      const fc = await isochrone(center, mode, ac.signal);
      if (ac.signal.aborted) return;
      if (fc) src.setData(fc);
    } catch (e) {
      if ((e as Error).name !== "AbortError") console.warn("등시선 실패", e);
    } finally {
      if (isoAbort.current === ac) setIsoLoading(false);
      mark("도달권역", false);
    }
  }

  // ─── 보행 경로 (가장 가까운 정류장·역) ───────────────────────────
  async function loadWalk(center: [number, number]) {
    const map = mapRef.current!;
    walkAbort.current?.abort();
    const ac = new AbortController();
    walkAbort.current = ac;

    const clear = () => {
      (map.getSource("walk") as MLGL.GeoJSONSource)?.setData(EMPTY);
      (map.getSource("walk-poi") as MLGL.GeoJSONSource)?.setData(EMPTY);
    };
    if (!stateRef.current.walk) { clear(); setWalks(null); return; }

    clear();
    setWalks("loading"); mark("보행 경로", true);
    try {
      const { walks } = await walkRoutes(center, ac.signal);
      if (ac.signal.aborted) return;
      (map.getSource("walk") as MLGL.GeoJSONSource).setData({
        type: "FeatureCollection",
        features: walks.map((w) => ({
          type: "Feature", properties: { kind: w.poi.kind },
          geometry: { type: "LineString", coordinates: w.line },
        })),
      });
      (map.getSource("walk-poi") as MLGL.GeoJSONSource).setData({
        type: "FeatureCollection",
        features: walks.map((w) => ({
          type: "Feature",
          properties: { kind: w.poi.kind, label: `${w.meters}m` },
          geometry: { type: "Point", coordinates: [w.poi.lon, w.poi.lat] },
        })),
      });
      setWalks(walks);
    } catch (e) {
      if ((e as Error).name !== "AbortError") { console.warn("보행경로 실패", e); setWalks([]); }
    } finally { mark("보행 경로", false); }
  }

  // ─── 토지특성(토지이음) 조회 ─────────────────────────────────────
  async function loadLand(pnu: string) {
    if (!pnu) return {};
    mark("토지특성", true);
    try {
    const yr = new Date().getFullYear();
    for (const y of [yr, yr - 1, yr - 2]) {
      try {
        const r = await fetch(vworld("ned/data/getLandCharacteristics", {
          pnu, stdrYear: String(y), numOfRows: "1", pageNo: "1", format: "json",
        })).then((x) => x.json());
        const f = r?.landCharacteristicss?.field?.[0] ?? r?.response?.fields?.field?.[0];
        if (f) return f as Record<string, string>;
      } catch (e) { console.warn("토지특성 조회 실패", e); }
    }
    return {};
    } finally { mark("토지특성", false); }
  }

  const pick = (land: Record<string, string>) => {
    const g = (...ks: string[]) => { for (const k of ks) if (land[k]) return land[k]; return ""; };
    return {
      uz: g("prposArea1Nm", "prposArea2Nm", "lclasUcdNm"),
      jimok: g("lndcgrCodeNm"),
      area: g("ladArea", "lndpclAr"),
      price: g("pblntfPclnd"),
      shape: g("ladShape", "tpgrphFrmNm"),
      road: g("roadSideCodeNm"),
    };
  };

  // ─── 주변(비-LH) 필지 클릭 조회 ─────────────────────────────────
  async function selectNeighbor(map: MLGL.Map, feat: GeoJSON.Feature) {
    const fp = (feat.properties ?? {}) as Record<string, string>;
    const pnu = fp.pnu || fp.PNU || "";
    const jibun = fp.jibun || "";

    (map.getSource("parcel-poly") as MLGL.GeoJSONSource).setData({
      type: "FeatureCollection", features: [{ type: "Feature", geometry: feat.geometry, properties: {} }],
    });
    selPoly.current = polysOf(feat.geometry);

    // 폴리곤을 눌렀어도 PNU가 LH 목록에 있으면 그 필지의 전체 속성을 쓴다
    const lh = pnu ? pnuMap.current.get(pnu) : undefined;
    const base: Props = lh ?? {
      id: "—", addr: fp.addr || jibun || "선택 필지", gu: "", dong: "", jibun, neighbor: "1",
      공시지가_2026: fp.jiga ?? "",
    };
    setSel({ p: base, loading: true, pnu });
    const c = centroidOf(feat.geometry);
    lastCenter.current = c;
    loadWalk(c);
    loadIso(c);
    loadStores(c);
    if (pnu) { loadTrades(pnu, base.dong || (fp.addr || "").split(" ")[2] || ""); loadBuilding(pnu); }
    const land = await loadLand(pnu);
    const pk = pick(land);
    if (pk.uz) lastUz.current = pk.uz;
    setSel({ p: base, loading: false, pnu, ...pk });
  }

  // ─── 필지 클릭 → VWorld 조회 ────────────────────────────────────
  async function selectParcel(feat: GeoJSON.Feature) {
    const p = feat.properties as Props;
    const ll = (feat.geometry as GeoJSON.Point).coordinates as [number, number];
    setSel({ p, loading: true });
    setFloors(null);
    const map = mapRef.current!;
    lastCenter.current = ll;
    loadWalk(ll);
    loadIso(ll);
    loadStores(ll);

    let pnu = "";
    try {
      const r = await fetch(vworld("req/data", {
        service: "data", request: "GetFeature", data: "LP_PA_CBND_BUBUN",
        geomFilter: `POINT(${ll[0]} ${ll[1]})`, geometry: "true", crs: "EPSG:4326", size: "1", format: "json",
      })).then((x) => x.json());
      const fc = r?.response?.result?.featureCollection;
      if (fc?.features?.length) {
        (map.getSource("parcel-poly") as MLGL.GeoJSONSource).setData(fc);
        selPoly.current = polysOf(fc.features[0].geometry);
        pnu = fc.features[0].properties.pnu || fc.features[0].properties.PNU || "";
        const b = new window.maplibregl.LngLatBounds();
        const walk = (a: unknown): void => {
          if (Array.isArray(a)) {
            if (typeof a[0] === "number") b.extend(a as [number, number]);
            else a.forEach(walk);
          }
        };
        walk(fc.features[0].geometry.coordinates);
        map.fitBounds(b, { padding: 150, maxZoom: 18, duration: 500 });
      }
    } catch (e) { console.warn("지적 조회 실패", e); }

    const finalPnu = pnu || p.PNU || "";
    if (finalPnu) { loadTrades(finalPnu, p.dong || ""); loadBuilding(finalPnu); }
    const land = await loadLand(finalPnu);
    const picked = pick(land);
    if (picked.uz) lastUz.current = picked.uz;
    setSel({ p, loading: false, pnu: finalPnu, ...picked });
  }

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={ref} style={{ position: "absolute", inset: 0 }} />

      <div className="panel">
        <h1>OSC 매입임대 노후필지</h1>
        <p className="sub">LH 『OSC기반 매입임대주택 정비모델 연구』(2025) 부록 · {total || "…"}필지</p>

        <div className="sec">
          <b>배경지도</b>
          {[["vbase", "VWorld 일반"], ["vsat", "VWorld 위성"], ["osm", "OSM"]].map(([v, l]) => (
            <label key={v} className="row">
              <input type="radio" name="base" checked={base === v} onChange={() => setBase(v)} /> {l}
            </label>
          ))}
        </div>

        <div className="sec">
          <b>중첩 레이어</b>
          <label className="row"><input type="checkbox" checked={cadastral} onChange={(e) => setCadastral(e.target.checked)} /> 지적도(연속지적)</label>
          <label className="row"><input type="checkbox" checked={usezone} onChange={(e) => setUsezone(e.target.checked)} /> 용도지역</label>
          <label className="row"><input type="checkbox" checked={vector} onChange={(e) => setVector(e.target.checked)} /> 필지경계 벡터 <span className="tag">z16+</span></label>
          <label className="row"><input type="checkbox" checked={walk} onChange={(e) => setWalk(e.target.checked)} /> 보행 경로(정류장·역)</label>
          <label className="row"><input type="checkbox" checked={showStores} onChange={(e) => setShowStores(e.target.checked)} /> 주변 상권 500m</label>
          <label className="row">
            <input type="checkbox" checked={mass3d} onChange={(e) => {
              setMass3d(e.target.checked);
              const mm = mapRef.current;
              if (mm && !e.target.checked) mm.easeTo({ pitch: 0, duration: 600 });
            }} /> 3D 최대매스
            {mass3d && <span className="m3d-lg"><i style={{background:"#1d4ed8"}}/>법정최대{showCur && <><i style={{background:"#cbd5e1"}}/>주변건물</>}</span>}
          </label>
          {mass3d && (
            <div className="sun-box">
              <label className="row" style={{ margin: 0 }}>
                <input type="checkbox" checked={showCur} onChange={(e) => setShowCur(e.target.checked)} /> 주변 건물 매스 <span className="tag" style={{background:"#0f766e"}}>VWorld</span>
              </label>
              {(() => {
                const z = zoneOf(mergeMode ? (mergeUz || lastUz.current) : (sel?.uz ?? ""));
                if (!z) return null;
                const biz = BIZ_TYPES.find((t) => t.id === bizId) ?? BIZ_TYPES[0];
                const far = farFor(z, biz);
                return (
                  <div className="biz">
                    <div className="biz-h">사업 유형</div>
                    <select value={bizId} onChange={(e) => { setBizId(e.target.value); setFloors(null); }}>
                      {BIZ_TYPES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    <div className="biz-info">
                      용적률 <b>{far}%</b>
                      {far !== z.far && <span className="up"> (기본 {z.far}% → +{far - z.far}%p)</span>}
                      <br />
                      <span className="dim2">{biz.note}</span><br />
                      <span className="law">{biz.law}</span>
                    </div>
                    <div className="biz-h" style={{ marginTop: 6 }}>
                      대지경계 이격 <b>{setback}m</b>
                    </div>
                    <input type="range" min={0} max={5} step={0.5} value={setback}
                      onChange={(e) => setSetback(Number(e.target.value))} />
                    {fpInfo && (
                      <div className="biz-info">
                        건축면적 <b>{fpInfo.area.toLocaleString()}㎡</b> · 건폐 {fpInfo.bcrUsed}% / {z.bcr}%<br />
                        <span className="dim2">
                          {fpInfo.limitedBy === "건폐율"
                            ? `건폐율에 걸려 ${fpInfo.setback}m 까지 이격됨`
                            : `이격 ${fpInfo.setback}m 적용 (건폐율 여유 있음)`}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })()}

              {(() => {
                const z = zoneOf(mergeMode ? (mergeUz || lastUz.current) : (sel?.uz ?? ""));
                if (!z) return null;
                const biz2 = BIZ_TYPES.find((t) => t.id === bizId) ?? BIZ_TYPES[0];
                const far2 = farFor(z, biz2);
                const siteArea = mergeMode
                  ? mergeList.reduce((a, x) => a + x.area, 0)
                  : (Number(sel?.area) || 0);
                const maxTot = siteArea * far2 / 100;
                const auto = fpInfo && fpInfo.area > 0 ? Math.max(1, Math.floor(maxTot / fpInfo.area)) : 1;
                const n = floors ?? auto;
                const totArea = fpInfo ? Math.min(maxTot, fpInfo.area * n) : 0;
                const fp = fpInfo && siteArea > 0 ? {
                  perFloor: fpInfo.area, totArea: +totArea.toFixed(0),
                  bcrUsed: fpInfo.bcrUsed, farUsed: +(totArea / siteArea * 100).toFixed(0),
                  farRatio: +(totArea / maxTot * 100).toFixed(1),
                  limitedBy: fpInfo.limitedBy,
                } : null;
                return (
                  <div className="flr">
                    <div className="flr-row">
                      <span>층수</span>
                      <button onClick={() => setFloors(Math.max(1, n - 1))}>−</button>
                      <b>{n}층</b>
                      <button onClick={() => setFloors(Math.min(20, n + 1))}>+</button>
                      {floors !== null && floors !== auto && (
                        <button className="rst" onClick={() => setFloors(null)}>자동</button>
                      )}
                    </div>
                    {fp && (
                      <div className="flr-info">
                        층당 {fp.perFloor.toLocaleString()}㎡ · 연면적 <b>{fp.totArea.toLocaleString()}㎡</b><br />
                        건폐 {fp.bcrUsed}% / {z.bcr}% · 용적 {fp.farUsed}% / {far2}%
                        <span className={fp.farRatio >= 99.5 ? "ok" : "warn"}> ({fp.farRatio}% 소진)</span><br />
                        <span className="dim2">{fp.limitedBy}에 걸림 · 자동 {auto}층</span>
                      </div>
                    )}
                  </div>
                );
              })()}
              <label className="row" style={{ margin: "4px 0 0" }}>
                <input type="checkbox" checked={piloti} onChange={(e) => setPiloti(e.target.checked)} /> 필로티 주차(1층)
              </label>
              <div className="park">
                <div className="biz-h">세대 전용면적</div>
                <div className="sun-rule">
                  {[21, 30, 45].map((u) => (
                    <button key={u} className={unitSize === u ? "on" : ""} onClick={() => setUnitSize(u)}>{u}㎡</button>
                  ))}
                </div>
                {parkInfo && (
                  <div className={`park-r${parkInfo.ok ? " ok" : parkInfo.pilotiArea ? " ng" : ""}`}>
                    법정 <b>{parkInfo.required}대</b>
                    {parkInfo.pilotiArea > 0 && (
                      <> · 필로티 {parkInfo.pilotiArea.toLocaleString()}㎡ → <b>{parkInfo.pilotiCars}대</b>
                        <span className="dim2"> ({parkInfo.perCar}㎡/대)</span></>
                    )}
                    <br /><span className="dim2">{parkInfo.note}</span>
                    {parkInfo.basementFloors > 0 && (
                      <><br /><span className="dim2">
                        지하 {parkInfo.basementFloors}개층 굴착 · 지하는 용적률 산정에서 제외 (시행령 §119①4)
                      </span></>
                    )}
                  </div>
                )}
                {fireInfo && fireInfo.required && (
                  <div className={`park-r${fireInfo.fromRoad ? " ok" : " ng"}`} style={{ marginTop: 4 }}>
                    소방차 진입 {fireInfo.fromRoad ? "가능" : "통로 필요"}
                    <br /><span className="dim2">{fireInfo.note}</span>
                  </div>
                )}
              </div>
              <label className="row" style={{ margin: "4px 0 0" }}>
                <input type="checkbox" checked={sunOn} onChange={(e) => setSunOn(e.target.checked)} /> 정북일조 사선
              </label>
              {sunOn && (
                <>
                  <div className="sun-rule">
                    {(["before", "after"] as SunRule[]).map((r) => (
                      <button key={r} className={sunRule === r ? "on" : ""} onClick={() => setSunRule(r)}>
                        {r === "before" ? "개정 전 9m" : "개정 후 10m"}
                      </button>
                    ))}
                  </div>
                  <div className="hint">
                    {SUNLIGHT_BASE[sunRule]}m 이하 1.5m · 초과분 높이의 1/2 이격
                    {sunLost !== null && sunLost > 0 && <> · 깎인 바닥 <b>{sunLost.toLocaleString()}㎡</b></>}
                  </div>
                  {showCur && (
                <div className="hint">
                  {nbldN < 0
                    ? "주변 건물 불러오는 중…"
                    : `주변 건물 ${nbldN}동 · VWorld GIS건물통합정보(발자국×층수)`}
                </div>
              )}
              {northInfo && (
                    <div className={`north${northInfo.found ? "" : " miss"}`}>
                      {northInfo.note}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          <label className="row">
            <input type="checkbox" checked={mergeMode} onChange={(e) => {
              setMergeMode(e.target.checked);
              if (!e.target.checked) setMergeList([]);
              else setSel(null);
            }} /> 합필 검토
            {mergeMode && <span className="tag" style={{background:"#047857"}}>{mergeList.length}필지</span>}
          </label>
          {mergeMode && <div className="hint">필지를 눌러 담고, 다시 누르면 뺍니다 (z16+ 필요)</div>}
          <div className="hint">
            {vector
              ? (zoom < CAD_MIN_ZOOM
                  ? `더 확대하면(z${CAD_MIN_ZOOM}+) 필지 경계가 벡터로 그려집니다 · 현재 z${zoom.toFixed(1)}`
                  : (cadLoading ? "필지 경계 불러오는 중…" : `화면 내 필지 ${cadCount.toLocaleString()}개 · 지번은 z17+`))
              : "핀 클릭 → 필지 경계 + VWorld·토지이음 조회"}
          </div>
        </div>

        <div className="sec">
          <b>도달권역 (등시선)</b>
          <select value={isoMode} onChange={(e) => setIsoMode(e.target.value as IsoMode | "")}>
            <option value="">표시 안 함</option>
            <option value="pedestrian">도보 5·10·15분</option>
            <option value="bicycle">자전거 10·20·30분</option>
            <option value="auto">자동차 10·20·30분</option>
            <option value="transit">지하철 10·20·30분</option>
          </select>
          {isoMode && (
            <div className="iso-legend">
              {(isoMode === "transit" ? TRANSIT_CONTOURS : ISO_CONTOURS[isoMode]).map((m, i) => (
                <span key={m} className="iso-key">
                  <i style={{ background: ["#ea580c", "#fb923c", "#fed7aa"][i] }} />{m}분
                </span>
              ))}
            </div>
          )}
          <div className="hint">
            {isoLoading ? "권역 계산 중…"
              : !lastCenter.current ? "필지를 클릭하면 그 지점 기준으로 그려집니다"
              : isoMode === "transit"
                ? (transitInfo
                    ? `승차 가능역 ${transitInfo.boarded} → 30분 내 ${transitInfo.reached}개역 · 최근접 ${transitInfo.nearest}역`
                    : "지하철 도달권역 · 선택 필지 기준")
                : `${ISO_LABEL[isoMode as IsoMode] ?? ""} 도달권역 · 선택 필지 기준`}
          </div>
          {isoMode === "transit" && (
            <div className="hint">OSM 노선 그래프 + 표정속도 33km/h·환승 3분 <b>추정</b> (GTFS 시간표 아님)</div>
          )}
        </div>

        <div className="sec">
          <b>필지 (OSC 공법유형)</b>
          {[["소형", "소형패널"], ["중형", "중형패널"], ["대형", "대형패널"], ["", "미배정"]].map(([k, l]) => (
            <label key={l} className="row">
              <input type="checkbox" checked={oscOn[k]} onChange={(e) => setOscOn({ ...oscOn, [k]: e.target.checked })} />
              <span className="dot" style={{ background: OSC[k] }} /> {l}
            </label>
          ))}
          <select value={gu} onChange={(e) => setGu(e.target.value)}>
            <option value="">전체 자치구</option>
            {gus.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <div className="cnt">{count} 필지 표시 중</div>
        </div>
      </div>

      {(() => {
        const on = Object.keys(busy).filter((k) => busy[k]);
        return on.length ? (
          <div className="busy">
            <span className="spin" />
            {on.map((k) => <span key={k} className="bchip">{k}</span>)}
          </div>
        ) : null;
      })()}

      {mergeMode && mergeList.length > 0 && (
        <MergeCard list={mergeList} uz={mergeUz || lastUz.current}
          onRemove={(pnu: string) => setMergeList((v) => v.filter((x) => x.pnu !== pnu))}
          onClear={() => setMergeList([])} />
      )}
      {!mergeMode && sel && <ParcelCard sel={sel} walks={walks} trades={trades} stores={stores} bld={bld} onClose={() => setSel(null)} />}
    </div>
  );
}

function ParcelCard({ sel, walks, trades, stores, bld, onClose }:
  { sel: Selection; walks: Walk[] | "loading" | null; trades: Trades | "loading" | null;
    stores: Stores | "loading" | null; bld: Bld | "loading" | null; onClose: () => void }) {
  const { p } = sel;
  const lg = legalOf(sel.uz ?? "");
  const [tab, setTab] = useState<"대지" | "규모" | "건물" | "주변">("대지");
  const Row = ({ k, b }: { k: string; b: string }) => (
    <tr><td className="k">{k}</td><td><b>{b}</b></td></tr>
  );
  const hasBld = !!(bld && bld !== "loading" && (bld.existing || bld.permit));
  const B = bld && bld !== "loading" ? bld : null;
  const areaNum = Number(sel.area) || B?.existing?.platArea || 0;
  const scForExport = scaleReview(areaNum, sel.uz ?? "", B?.existing
    ? { arch: B.existing.archArea, tot: B.existing.totArea, bcr: B.existing.bcRat, vlRat: B.existing.vlRat }
    : undefined);
  const expInput: ExportInput = {
    addr: p.addr, pnu: sel.pnu ?? "", id: p.id ?? "",
    land: { uz: sel.uz ?? "", jimok: sel.jimok ?? "", area: sel.area ?? "",
            price: sel.price ?? "", road: sel.road ?? "", shape: sel.shape ?? "" },
    lh: p, scale: scForExport, bld: B,
    trades: trades && trades !== "loading" ? trades : null,
    stores: stores && stores !== "loading" ? stores : null,
    walks: walks && walks !== "loading"
      ? walks.map((w) => ({ name: w.poi.name, kind: w.poi.kind, meters: w.meters, seconds: w.seconds }))
      : null,
  };
  const TABS: ["대지" | "규모" | "건물" | "주변", string, boolean][] = [
    ["대지", "대지", true],
    ["규모", "규모검토", true],
    ["건물", "건물", hasBld],
    ["주변", "주변·시세", true],
  ];
  return (
    <div className="card">
      <button className="x" onClick={onClose}>×</button>
      <h2>{p.addr}</h2>
      <div className="pnu">
        {p.neighbor ? <span className="badge">주변 필지</span> : <>고유번호 {p.id}</>}
        {sel.pnu ? ` · PNU ${sel.pnu}` : ""}
      </div>

      {sel.loading ? (
        <div style={{ color: "#888", padding: "8px 0" }}>VWorld·토지이음 조회 중…</div>
      ) : (
        <>
          <div className="tabs">
            {TABS.filter(([, , on]) => on).map(([k, label]) => (
              <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
          <div className="exp">
            <button onClick={() => downloadCSV(expInput)}>CSV 내려받기</button>
            <button onClick={() => printSheet(expInput)}>조사서 인쇄 · PDF</button>
          </div>

          <div className="tab-body">
          {tab === "대지" && (
            <>
              <table>
                <thead><tr><th></th><th>VWorld·토지이음</th></tr></thead>
                <tbody>
                  <Row k="용도지역" b={sel.uz || "–"} />
                  <Row k="지목" b={sel.jimok || "–"} />
                  <Row k="면적" b={sel.area ? `${(+sel.area).toLocaleString()}㎡` : (p.대지면적 ? `${nf(p.대지면적)}㎡` : "–")} />
                  <Row k="건폐율" b={lg ? `법정 ${lg[0]}%` : "–"} />
                  <Row k="용적률" b={lg ? `법정 ${lg[1]}%` : "–"} />
                  <Row k="지형형상" b={sel.shape || p.지형형상 || "–"} />
                  <Row k="도로접면" b={sel.road || p.도로접면 || "–"} />
                  <Row k="개별공시지가" b={sel.price ? `${(+sel.price).toLocaleString()}원/㎡` : (p.공시지가_2026 ? `${(+p.공시지가_2026).toLocaleString()}원/㎡` : "–")} />
                </tbody>
              </table>

              {(() => {
                const gong = Number(sel.price || p.공시지가_2026) || 0;
                const t = trades && trades !== "loading" ? trades : null;
                if (!gong || !t || !(t.median > 0)) return null;
                const ratio = t.median / gong;                 // 시세 ÷ 공시지가 (배)
                const gapM = Math.round((t.median - gong) / 10000); // 차익(만원/㎡)
                const areaSqm = Number(sel.area || p.대지면적) || 0;
                const totalGap = areaSqm > 0 ? Math.round(((t.median - gong) * areaSqm) / 1e8) : 0; // 대지 전체 차익(억)
                return (
                  <div className="price-gap">
                    <div className="pg-row">
                      <span>공시지가</span><b>{Math.round(gong / 10000).toLocaleString()}만원/㎡</b>
                    </div>
                    <div className="pg-row">
                      <span>인근 시세<em>실거래 중앙값</em></span><b>{Math.round(t.median / 10000).toLocaleString()}만원/㎡</b>
                    </div>
                    <div className="pg-diff">
                      시세가 공시지가의 <b>{ratio.toFixed(2)}배</b>
                      {gapM > 0 && <> · 차익 <b>+{gapM.toLocaleString()}만원/㎡</b></>}
                      {totalGap > 0 && <> (대지 {areaSqm.toLocaleString()}㎡ 기준 약 <b>{totalGap}억</b>)</>}
                      <span className="pg-src"> · {t.scope === "dong" ? t.dong : "자치구 전체"} 온전대지 {t.n}건 / 최근 {t.months}개월</span>
                    </div>
                  </div>
                );
              })()}
              {!p.neighbor && (
                <div className="meta">
                  주택형태 <b>{p.주택형태 || "–"}</b> · 노후 {nf(p.노후년수)}년 · 임대 {nf(p.임대세대수)}세대 · OSC <b>{p.OSC공법 || "미배정"}</b>
              {p.신규임대유형 ? <> · 신규유형 <b>{p.신규임대유형}</b></> : null}
            </div>
          )}
          {!p.neighbor && p.버스정류장 !== undefined && (
            <div className="poi">
              <div className="poi-h">도보권 800m 내 생활편의시설 <span className="src">LH 연구 부록</span></div>
              <div className="poi-grid">
                {POI_KEYS.map(([k, label]) => (
                  <div key={k} className={`poi-cell${+(p[k] ?? 0) === 0 ? " zero" : ""}`}>
                    <span>{label}</span><b>{p[k] ?? "–"}</b>
                  </div>
                ))}
              </div>
            </div>
          )}
            </>
          )}

          {tab === "규모" && (
            <>
          {(() => {
            const area = Number(sel.area) || Number(bld && bld !== "loading" ? bld.existing?.platArea : 0) || 0;
            const sc = scaleReview(area, sel.uz ?? "", bld && bld !== "loading" && bld.existing
              ? { arch: bld.existing.archArea, tot: bld.existing.totArea,
                  bcr: bld.existing.bcRat, vlRat: bld.existing.vlRat }
              : undefined);
            return sc ? <ScaleBox sc={sc} /> : null;
          })()}
            </>
          )}

          {tab === "건물" && (
            <>
          {bld && bld !== "loading" && (bld.existing || bld.permit) && (
            <div className="poi">
              <div className="poi-h">필지 위 건물 <span className="src">건축HUB 대장·인허가</span></div>
              <div className={bld.permit && !bld.permit.sameAsExisting ? "bld-cols" : "bld-cols one"}>
                {bld.existing && (
                  <div className="bld-col">
                    <div className="bld-t">기존 건물 <span className="wdiff">대장</span></div>
                    <div className="bld-k">{bld.existing.strct || "–"}</div>
                    <div className="bld-k">
                      지상 {bld.existing.grndFlr ?? "–"}
                      {bld.existing.ugrndFlr ? ` / 지하 ${bld.existing.ugrndFlr}` : ""}층
                      {bld.existing.heit ? ` · ${bld.existing.heit}m` : ""}
                    </div>
                    <div className="bld-k">연면적 <b>{bld.existing.totArea?.toLocaleString() ?? "–"}㎡</b></div>
                    <div className="bld-k">건폐 {bld.existing.bcRat ?? "–"}% · 용적 {bld.existing.vlRat ?? "–"}%</div>
                    <div className="bld-k">
                      {bld.existing.fmly ? `${bld.existing.fmly}가구` : bld.existing.hhld ? `${bld.existing.hhld}세대` : "–"}
                      {(bld.existing.pkngIn ?? 0) + (bld.existing.pkngOut ?? 0) > 0
                        ? ` · 주차 ${(bld.existing.pkngIn ?? 0) + (bld.existing.pkngOut ?? 0)}대` : " · 주차 0대"}
                    </div>
                    <div className="bld-k">사용승인 <b>{bld.existing.useAprDay || "–"}</b></div>
                  </div>
                )}
                {bld.permit && !bld.permit.sameAsExisting && (
                  <div className={`bld-col ${bld.permit.status === "허가만" ? "plan" : "hist"}`}>
                    <div className="bld-t">
                      {bld.permit.gb || "인허가"}{" "}
                      <span className="wdiff">
                        {bld.permit.status === "허가만" ? "허가만 · 미착공"
                          : bld.permit.status === "공사중" ? "공사중"
                          : bld.permit.sameAsExisting ? "이 건물의 이력" : "준공"}
                      </span>
                    </div>
                    <div className="bld-k">{bld.permit.strct || "–"}</div>
                    <div className="bld-k">
                      {bld.permit.flrs.filter((f) => f.gb === "지상").length
                        ? `지상 ${bld.permit.flrs.filter((f) => f.gb === "지상").length}층` : "–"}
                      {bld.permit.flrs.some((f) => f.gb === "지하") ? " / 지하 있음" : ""}
                    </div>
                    <div className="bld-k">연면적 <b>{bld.permit.totArea?.toLocaleString() ?? "–"}㎡</b></div>
                    <div className="bld-k">건폐 {bld.permit.bcRat ?? "–"}% · 용적 {bld.permit.vlRat ?? "–"}%</div>
                    <div className="bld-k">
                      {bld.permit.fmly ? `${bld.permit.fmly}가구` : bld.permit.hhld ? `${bld.permit.hhld}세대` : "–"}
                      {` · 주차 ${bld.permit.pkng ?? 0}대`}
                    </div>
                    <div className="bld-k">허가 <b>{bld.permit.pmsDay || "–"}</b></div>
                    <div className="bld-k">
                      착공 {bld.permit.stcnsDay || "–"} · 사용승인 {bld.permit.useAprDay || "–"}
                    </div>
                  </div>
                )}
              </div>
              {bld.permit?.name && !bld.permit.sameAsExisting && <div className="bld-nm">{bld.permit.name}</div>}
              {bld.permit?.status === "허가만" && (
                <div className="bld-warn">
                  신축 허가({bld.permit.pmsDay})는 났으나 착공·사용승인 기록이 없습니다.
                  현재 건물은 왼쪽 대장 기준입니다.
                </div>
              )}
              {bld.permit?.sameAsExisting && (
                <div className="bld-same">
                  인허가 이력이 대장과 일치 — 허가 {bld.permit.pmsDay || "–"}
                  {bld.permit.stcnsDay ? ` → 착공 ${bld.permit.stcnsDay}` : ""}
                  {` → 준공 ${bld.permit.useAprDay}`}. 계획된 신축·증축은 없습니다.
                </div>
              )}
              {bld.permit?.guyuk && <div className="wdiff">구역: {bld.permit.guyuk}</div>}
              {(() => {
                const useExisting = !bld.permit || bld.permit.sameAsExisting;
                const flrs = useExisting ? bld.existing?.flrs ?? [] : bld.permit!.flrs;
                if (!flrs.length) return null;
                return (
                  <div className="wdiff" style={{ marginTop: 3 }}>
                    {useExisting ? "층별(대장)" : "층별(인허가)"}:{" "}
                    {flrs.map((f) => `${f.gb}${f.no ?? ""} ${f.purps} ${f.area ?? "–"}㎡`).join(" · ")}
                  </div>
                );
              })()}
            </div>
          )}
            </>
          )}

          {tab === "주변" && (
            <>
          {trades && trades !== "loading" && (
            <div className="poi">
              <div className="poi-h">
                인근 토지 실거래 <span className="src">국토부 · 최근 {trades.months}개월</span>
              </div>
              <div className="tr-head">
                {trades.scope === "dong" ? trades.dong : "자치구 전체"} · 온전한 대지 {trades.n}건
                {trades.scope === "sgg" && <span className="wdiff"> (동 표본 부족)</span>}
              </div>
              <div className="tr-bar">
                <div className="tr-range">
                  <span>{(trades.p25 / 10000).toFixed(0)}만</span>
                  <i />
                  <b>{(trades.median / 10000).toFixed(0)}만원/㎡</b>
                  <i />
                  <span>{(trades.p75 / 10000).toFixed(0)}만</span>
                </div>
                {p.공시지가_2026 && trades.median > 0 && (
                  <div className="tr-cmp">
                    공시지가 {(+p.공시지가_2026 / 10000).toFixed(0)}만원/㎡ ={" "}
                    <b>실거래 중앙값의 {Math.round((+p.공시지가_2026 / trades.median) * 100)}%</b>
                  </div>
                )}
              </div>
              {trades.recent.slice(0, 3).map((t, i) => (
                <div key={i} className="walk-row">
                  <span className="wname">{t.ym} · {t.landUse || "–"}</span>
                  <span className="wmin">{t.area.toLocaleString()}㎡</span>
                  <b>{(t.unit / 10000).toFixed(0)}만/㎡</b>
                </div>
              ))}
            </div>
          )}

          {stores && stores !== "loading" && (
            <div className="poi">
              <div className="poi-h">
                주변 상권 반경 {stores.radius}m <span className="src">소상공인시장진흥공단</span>
              </div>
              <div className="tr-head">총 <b>{stores.total.toLocaleString()}</b>개 업소</div>
              <div className="st-bars">
                {stores.lcls.slice(0, 6).map(([name, n]) => (
                  <div key={name} className="st-row">
                    <span className="st-n">{name}</span>
                    <span className="st-track">
                      <i style={{
                        width: `${(n / stores.lcls[0][1]) * 100}%`,
                        background: STORE_COLOR[name] ?? "#94a3b8",
                      }} />
                    </span>
                    <b>{n}</b>
                  </div>
                ))}
              </div>
              <div className="wdiff" style={{ marginTop: 4 }}>
                주요 업종: {stores.mcls.slice(0, 4).map(([m, n]) => `${m} ${n}`).join(" · ")}
              </div>
            </div>
          )}
          {walks && (
            <div className="poi">
              <div className="poi-h">실제 보행 경로 <span className="src">OSM · Valhalla</span></div>
              {walks === "loading" ? (
                <div style={{ fontSize: 11.5, color: "#888" }}>경로 계산 중…</div>
              ) : walks.length === 0 ? (
                <div style={{ fontSize: 11.5, color: "#888" }}>주변 정류장·역을 찾지 못했습니다</div>
              ) : (
                walks.map((w, i) => (
                  <div key={i} className="walk-row">
                    <span className="wdot" style={{ background: w.poi.kind === "subway" ? "#7c3aed" : "#0284c7" }} />
                    <span className="wname">{w.poi.name}</span>
                    <b>{w.meters.toLocaleString()}m</b>
                    <span className="wmin">도보 {Math.max(1, Math.round(w.seconds / 60))}분</span>
                    <span className="wdiff">직선 {Math.round(w.poi.straight)}m</span>
                  </div>
                ))
              )}
            </div>
          )}
            </>
          )}
          </div>
        </>
      )}
    </div>
  );
}


function ScaleBox({ sc }: { sc: Scale }) {
  const pct = (v: number, max: number) => Math.max(0, Math.min(100, (v / max) * 100));
  return (
    <div className="poi">
      <div className="poi-h">
        규모검토 <span className="src">개략 · 서울시 조례 상한</span>
      </div>
      <div className="tr-head">
        대지 <b>{sc.platArea.toLocaleString()}㎡</b> · {sc.zone.name} · 건폐 {sc.zone.bcr}% / 용적 {sc.zone.far}%
        {sc.zone.heightNote && <span className="wdiff"> · {sc.zone.heightNote}</span>}
      </div>

      <div className="sc-rows">
        <div className="sc-row">
          <span className="sc-k">건축면적</span>
          <span className="sc-track">
            {sc.cur?.arch ? <i className="cur" style={{ width: `${pct(sc.cur.arch, sc.maxArch)}%` }} /> : null}
          </span>
          <span className="sc-v">
            <b>{sc.maxArch.toLocaleString()}</b>㎡
            {sc.cur?.arch ? <em> 현 {sc.cur.arch.toLocaleString()}</em> : null}
          </span>
        </div>
        <div className="sc-row">
          <span className="sc-k">연면적</span>
          <span className="sc-track">
            {sc.cur?.tot ? <i className="cur" style={{ width: `${pct(sc.cur.tot, sc.maxTot)}%` }} /> : null}
          </span>
          <span className="sc-v">
            <b>{sc.maxTot.toLocaleString()}</b>㎡
            {sc.cur?.tot ? <em> 현 {sc.cur.tot.toLocaleString()}</em> : null}
          </span>
        </div>
      </div>

      {sc.spare && (
        <div className={`sc-spare${sc.spare.tot > 0 ? "" : " over"}`}>
          {sc.spare.tot > 0
            ? <>여유 연면적 <b>{sc.spare.tot.toLocaleString()}㎡</b> · 층수 여지 약 {sc.floors}층까지</>
            : <>현재 건물 연면적이 지금 기준 법정 상한보다 <b>{Math.abs(sc.spare.tot).toLocaleString()}㎡ 큼</b> — 구법 기준으로 지은 <b>기존 부적합 건축물</b>일 수 있음(신축 시 이만큼 못 지음)</>}
        </div>
      )}

      <table className="sc-tb">
        <thead><tr><th>세대 유형</th><th>세대수</th><th>법정주차</th></tr></thead>
        <tbody>
          {sc.cases.map((c) => (
            <tr key={c.label} title={c.rule}>
              <td>{c.label}</td>
              <td><b>{c.units}</b>세대</td>
              <td><b>{c.parking}</b>대</td>
            </tr>
          ))}
          <tr title="주차장법 시행령 별표1 — 150㎡ 초과 100㎡당 1대">
            <td>다가구(단독)</td>
            <td className="wdiff">연면적 기준</td>
            <td><b>{sc.parkingDagagu}</b>대</td>
          </tr>
        </tbody>
      </table>

      <div className="wdiff" style={{ marginTop: 4, lineHeight: 1.5 }}>
        {sc.sunlight}<br />
        ※ 대지안의 공지·건축선 후퇴·가로구역 최고높이·지구단위계획 미반영. 인허가는 건축사 검토 필요.
      </div>
    </div>
  );
}

function MergeCard({ list, uz, onRemove, onClear }: {
  list: (MergeParcel & { coords: GeoJSON.Position[][] })[];
  uz: string;
  onRemove: (pnu: string) => void;
  onClear: () => void;
}) {
  const [unit, setUnit] = useState(21);
  const mr: MergeReview | null = mergeReview(list, uz, unit);
  const sum = list.reduce((s, x) => s + x.area, 0);

  return (
    <div className="card">
      <button className="x" onClick={onClear}>×</button>
      <h2>합필 검토</h2>
      <div className="pnu">
        {list.length}필지 · 합계 <b>{sum.toLocaleString()}㎡</b>
        {uz ? ` · ${uz}` : " · 용도지역 미확인(필지를 한 번 조회하세요)"}
      </div>

      <div className="tab-body">
        <div className="mg-list">
          {list.map((x) => (
            <div key={x.pnu} className="mg-row">
              <span className="mg-a">{x.addr}</span>
              <b>{x.area.toLocaleString()}㎡</b>
              <button onClick={() => onRemove(x.pnu)}>×</button>
            </div>
          ))}
        </div>

        {!mr ? (
          <div className="wdiff" style={{ marginTop: 8 }}>
            2필지 이상 선택하고, 용도지역이 확인되면 비교가 나옵니다.
          </div>
        ) : (
          <>
            <div className="poi">
              <div className="poi-h">
                개별 개발 vs 합필 <span className="src">코어 중복 기준 · 개략</span>
              </div>
              <div className="mg-unit">
                세대 전용면적
                {[21, 30, 45].map((u) => (
                  <button key={u} className={unit === u ? "on" : ""} onClick={() => setUnit(u)}>{u}㎡</button>
                ))}
              </div>
              <table className="sc-tb">
                <thead><tr><th></th><th>개별 {mr.n}동</th><th>합필 1동</th></tr></thead>
                <tbody>
                  <tr><td>최대 연면적</td><td>{mr.sep.maxTot.toLocaleString()}㎡</td><td>{mr.mrg.maxTot.toLocaleString()}㎡</td></tr>
                  <tr><td>코어(계단·EV)</td><td>−{mr.sep.core.toLocaleString()}㎡</td><td>−{mr.mrg.core.toLocaleString()}㎡</td></tr>
                  <tr><td><b>가용 면적</b></td><td><b>{mr.sep.usable.toLocaleString()}㎡</b></td><td><b>{mr.mrg.usable.toLocaleString()}㎡</b></td></tr>
                  <tr><td>{unit}㎡형 세대</td><td><b>{mr.sep.units}</b>세대</td><td><b>{mr.mrg.units}</b>세대</td></tr>
                </tbody>
              </table>
              <div className={`sc-spare${mr.gainArea >= 0 ? "" : " over"}`}>
                합필 시 가용면적 <b>{mr.gainArea >= 0 ? "+" : ""}{mr.gainArea.toLocaleString()}㎡</b>
                {" · "}세대 <b>{mr.gainUnits >= 0 ? "+" : ""}{mr.gainUnits}</b>
                {mr.mrg.evOk ? " · 엘리베이터 설치 가능" : " · 대지 330㎡ 미만이라 EV 미반영"}
              </div>
              <div className="wdiff" style={{ lineHeight: 1.5 }}>
                건폐·용적 상한은 면적에 비례해 총량이 같습니다. 차이는 <b>코어 중복</b>에서 납니다 —
                개별이면 필지마다 계단·홀({20}㎡/층)이 들어가고, 합필하면 코어 하나로 통합되며
                엘리베이터·커뮤니티가 성립합니다.<br />
                ※ 코어 20㎡/층·EV 15㎡/층·층고 3m 가정. 정북일조·대지안의공지·주차 진출입 미반영.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
