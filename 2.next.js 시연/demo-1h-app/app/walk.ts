// 보행 접근성: 주변 정류장·역 탐색(정적 POI) + 실제 보행 경로·등시선(FOSSGIS OSRM)
//
// 라우팅은 routing.openstreetmap.de — openstreetmap.org 지도가 그대로 쓰는 OSRM 서버다.
// 무키, CORS 허용, foot/bike/car 프로파일 제공.
//   (예전엔 valhalla1.openstreetmap.de 를 썼는데 그 공개 인스턴스가 내려갔다.
//    2025년 기준 접속 거부 — Failed to fetch. OSRM 쪽으로 옮김.)
// 실무 전환 시 서울 열린데이터광장 정류소 + TMAP 보행자 API 로 교체.

import * as turf from "@turf/turf";
import polygonClipping from "polygon-clipping";

export type Poi = {
  kind: "bus" | "subway";
  name: string;
  lon: number;
  lat: number;
  straight: number; // 직선거리 m
};

export type Walk = {
  poi: Poi;
  meters: number;   // 실제 보행 거리
  seconds: number;  // 예상 소요
  line: [number, number][];
};

// FOSSGIS OSRM. seg = URL 경로 조각, api = /route/v1/<api>/ 의 프로파일명.
// 먼저 서버 프록시(/api/osrm)로 — CORS 없고 미러·재시도가 있다. 안 되면 공개 인스턴스 직접.
const OSRM_BASES = ["/api/osrm", "https://routing.openstreetmap.de"];

/** OSRM 한 요청을 프록시 → 직접 순으로 시도. `sub` 는 "routed-foot/route/v1/foot/..." (쿼리 포함) */
async function osrmGet(sub: string, sig: AbortSignal): Promise<unknown | null> {
  for (const base of OSRM_BASES) {
    try {
      const r = await fetch(`${base}/${sub}`, { signal: sig });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.code !== "Unavailable" && j.code !== "Invalid") return j;
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
    }
  }
  return null;
}
const OSRM_PROFILE: Record<IsoMode, { seg: string; api: string; kmh: number }> = {
  pedestrian: { seg: "routed-foot", api: "foot", kmh: 4.5 },
  bicycle:    { seg: "routed-bike", api: "bike", kmh: 15 },
  auto:       { seg: "routed-car",  api: "driving", kmh: 32 },
};

const POI_URL = "/data/poi_seoul.json";

const R = 6371000;
export function haversine(a: [number, number], b: [number, number]) {
  const t = Math.PI / 180;
  const dLat = (b[1] - a[1]) * t, dLon = (b[0] - a[0]) * t;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * t) * Math.cos(b[1] * t) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

type PoiRow = { n: string; x: number; y: number; e?: number };
let POI_CACHE: { bus: PoiRow[]; subway: PoiRow[] } | null = null;

/** 정적 POI 파일 (서울 전역). 최초 1회만 로드 후 메모리 캐시. */
async function poiTable(signal?: AbortSignal) {
  if (POI_CACHE) return POI_CACHE;
  const r = await fetch(POI_URL, { signal });
  if (!r.ok) throw new Error("POI 파일 없음");
  POI_CACHE = await r.json();
  return POI_CACHE!;
}

/** 필지 주변 버스정류장·지하철역 — 로컬 최근접 탐색(네트워크 호출 없음) */
export async function findPois(center: [number, number], signal?: AbortSignal): Promise<Poi[]> {
  const tbl = await poiTable(signal);
  const near = (rows: PoiRow[], kind: Poi["kind"], maxM: number): Poi[] => {
    const deg = maxM / 111000 * 1.5; // 사각 프리필터
    const out: Poi[] = [];
    for (const p of rows) {
      if (Math.abs(p.x - center[0]) > deg || Math.abs(p.y - center[1]) > deg) continue;
      const d = haversine(center, [p.x, p.y]);
      if (d <= maxM) out.push({ kind, name: p.n, lon: p.x, lat: p.y, straight: d });
    }
    return out;
  };
  // 지하철은 출입구를 우선 (역 중심점은 실제 진입점과 멀 수 있음)
  const subs = tbl.subway;
  const entrances = near(subs.filter((s) => s.e), "subway", 1600);
  const stations = near(subs.filter((s) => !s.e), "subway", 1600);
  const sub = entrances.length ? entrances : stations;
  return [...near(tbl.bus, "bus", 1500), ...sub].sort((a, b) => a.straight - b.straight);
}

function withTimeout(ms: number, signal?: AbortSignal) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), ms);
  const sig = signal ? AbortSignal.any([signal, c.signal]) : c.signal;
  return { sig, done: () => clearTimeout(timer) };
}

/** 실제 보행 경로 (타임아웃 8초) */
export async function route(from: [number, number], poi: Poi, signal?: AbortSignal): Promise<Walk | null> {
  const { sig, done } = withTimeout(8000, signal);
  try {
    const p = OSRM_PROFILE.pedestrian;
    const sub =
      `${p.seg}/route/v1/${p.api}/` +
      `${from[0]},${from[1]};${poi.lon},${poi.lat}` +
      `?overview=full&geometries=geojson`;
    const j = await osrmGet(sub, sig) as { routes?: { geometry?: { coordinates?: [number, number][] }; distance?: number; duration?: number }[] } | null;
    if (!j) return null;
    const rt = j?.routes?.[0];
    const line = rt?.geometry?.coordinates;
    if (!rt || !line?.length) return null;
    return {
      poi,
      meters: Math.round(rt.distance ?? 0),
      seconds: Math.round(rt.duration ?? 0),
      line,
    };
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    console.warn("[OSRM] 경로 실패:", e);
    return null;
  } finally {
    done();
  }
}

/** 후보들의 실제 보행거리를 한 번에 (직선 최단 ≠ 보행 최단 이라 필수) */
async function matrix(from: [number, number], cands: Poi[], signal?: AbortSignal) {
  const { sig, done } = withTimeout(8000, signal);
  try {
    const p = OSRM_PROFILE.pedestrian;
    const coords = [from, ...cands.map((c) => [c.lon, c.lat] as [number, number])]
      .map((c) => `${c[0]},${c[1]}`)
      .join(";");
    const sub = `${p.seg}/table/v1/${p.api}/${coords}?sources=0&annotations=duration,distance`;
    const j = await osrmGet(sub, sig) as { durations?: (number | null)[][]; distances?: (number | null)[][] } | null;
    if (!j) return null;
    const dur = j?.durations?.[0];
    const dis = j?.distances?.[0];
    if (!Array.isArray(dur)) return null;
    // 인덱스 0 = 출발지 자신. 후보는 1번부터.
    return cands.map((_, i) => ({
      meters: dis?.[i + 1] ?? Infinity,
      seconds: dur[i + 1] ?? Infinity,
    }));
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    console.warn("[OSRM] 매트릭스 실패:", e);
    return null;
  } finally {
    done();
  }
}

/**
 * 버스정류장·지하철역 각각에 대해 후보 3곳의 **실제 보행거리**를 비교해
 * 가장 가까운 곳으로 경로를 그린다. (직선거리 1위가 도보 1위가 아닌 경우가 많음)
 */
export async function walkRoutes(center: [number, number], signal?: AbortSignal) {
  const pois = await findPois(center, signal);
  const cands = [
    ...pois.filter((p) => p.kind === "bus").slice(0, 3),
    ...pois.filter((p) => p.kind === "subway").slice(0, 3),
  ];
  if (!cands.length) return { pois, walks: [] as Walk[] };

  const m = await matrix(center, cands, signal);
  const best: Record<string, Poi> = {};
  if (m) {
    const bestM: Record<string, number> = {};
    cands.forEach((p, i) => {
      const d = m[i]?.meters ?? Infinity;
      if (!Number.isFinite(d)) return;
      if (bestM[p.kind] === undefined || d < bestM[p.kind]) { bestM[p.kind] = d; best[p.kind] = p; }
    });
  }
  for (const k of ["bus", "subway"]) {
    if (!best[k]) {
      const f = pois.find((p) => p.kind === k);
      if (f) best[k] = f;
    }
  }

  const picks = Object.values(best);
  const walks = await Promise.all(picks.map((p) => route(center, p, signal)));
  return { pois, walks: walks.filter(Boolean) as Walk[] };
}

// ─── 등시선(도보·자전거·자동차) ──────────────────────────────────
// OSRM 에는 등시선 API 가 없다. 중심에서 방위각 16방향 × 반경 5단계로 목표점을 뿌리고
// /table 한 번으로 소요시간을 받아, 방위각마다 "budget 을 넘지 않는 최대 반경"을 보간한다.
// → 원이 아니라 도로망을 따라 찌그러진 실제 모양이 나온다.

export type IsoMode = "pedestrian" | "bicycle" | "auto";
export const ISO_CONTOURS: Record<IsoMode, number[]> = {
  pedestrian: [5, 10, 15],
  bicycle: [10, 20, 30],
  auto: [10, 20, 30],
};
export const ISO_LABEL: Record<IsoMode, string> = {
  pedestrian: "도보", bicycle: "자전거", auto: "자동차",
};

const BEARINGS = 16;
const RINGS = [0.28, 0.5, 0.72, 0.9, 1.06]; // 최대반경 대비 비율

function offset(center: [number, number], distM: number, angRad: number): [number, number] {
  const dLat = (distM * Math.cos(angRad)) / 111320;
  const dLon = (distM * Math.sin(angRad)) / (111320 * Math.cos((center[1] * Math.PI) / 180));
  return [center[0] + dLon, center[1] + dLat];
}

export async function isochrone(
  center: [number, number], mode: IsoMode, signal?: AbortSignal
): Promise<GeoJSON.FeatureCollection | null> {
  const mins = ISO_CONTOURS[mode];
  const p = OSRM_PROFILE[mode];
  const asc = [...mins].sort((a, b) => a - b);

  // 최대 등고선이 직선으로 닿을 수 있는 거리 (도로 우회 감안해 여유는 RINGS 가 준다)
  const reach = (p.kmh * 1000 / 3600) * (Math.max(...mins) * 60);

  const targets: [number, number][] = [];
  const meta: { b: number; r: number }[] = [];
  for (let bi = 0; bi < BEARINGS; bi++) {
    const ang = (bi / BEARINGS) * 2 * Math.PI;
    for (const rr of RINGS) {
      const d = reach * rr;
      targets.push(offset(center, d, ang));
      meta.push({ b: bi, r: d });
    }
  }

  const { sig, done } = withTimeout(12000, signal);
  try {
    const coords = [center, ...targets].map((c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`).join(";");
    const sub = `${p.seg}/table/v1/${p.api}/${coords}?sources=0&annotations=duration`;
    const j = await osrmGet(sub, sig) as { durations?: (number | null)[][] } | null;
    {
      const dur = j?.durations?.[0];
      if (Array.isArray(dur)) {
        // 방위각별 (반경, 시간). 중심은 (0, 0)
        const perB: { r: number; t: number }[][] = Array.from({ length: BEARINGS }, () => [{ r: 0, t: 0 }]);
        meta.forEach((m, i) => {
          const t = dur[i + 1];
          if (t != null && Number.isFinite(t)) perB[m.b].push({ r: m.r, t });
        });
        for (const arr of perB) arr.sort((a, b) => a.r - b.r);

        const feats: GeoJSON.Feature[] = [];
        [...mins].sort((a, b) => b - a).forEach((mn) => {
          const budget = mn * 60;
          const ring: GeoJSON.Position[] = [];
          for (let bi = 0; bi < BEARINGS; bi++) {
            const ss = perB[bi];
            let rad = 0;
            for (let k = 0; k < ss.length; k++) {
              if (ss[k].t <= budget) { rad = ss[k].r; continue; }
              const a = ss[k - 1] ?? { r: 0, t: 0 };
              if (ss[k].t > a.t) rad = a.r + (ss[k].r - a.r) * (budget - a.t) / (ss[k].t - a.t);
              break;
            }
            ring.push(offset(center, rad, (bi / BEARINGS) * 2 * Math.PI));
          }
          ring.push(ring[0]);
          feats.push({
            type: "Feature",
            properties: { idx: asc.indexOf(mn), contour: mn, kind: "iso" },
            geometry: { type: "Polygon", coordinates: [ring] },
          });
        });

        if (feats.some((f) => turf.area(f) > 500)) {
          return { type: "FeatureCollection", features: feats };
        }
      }
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") { done(); throw e; }
    console.warn("[OSRM] 등시선 실패:", e);
  } finally {
    done();
  }

  return localIsochroneFallback(center, mode);
}

/** 로컬 원형 추정 — 네트워크 없이 즉시. OSRM 결과가 오면 교체된다. */
export function isochroneEstimate(center: [number, number], mode: IsoMode): GeoJSON.FeatureCollection {
  return localIsochroneFallback(center, mode);
}

/** 로컬 원형 폴백 — OSRM 이 안 될 때만. '대략치' 로 표시된다 */
function localIsochroneFallback(center: [number, number], mode: IsoMode): GeoJSON.FeatureCollection {
  const v = OSRM_PROFILE[mode].kmh;
  const contours = ISO_CONTOURS[mode];
  const asc = [...contours].sort((a, b) => a - b);
  const feats: GeoJSON.Feature[] = [];
  [...contours].sort((a, b) => b - a).forEach((mins) => {
    const r = (v * 1000 / 60) * mins * 0.7; // 도로 우회 70%
    feats.push({
      type: "Feature",
      properties: { idx: asc.indexOf(mins), contour: mins, kind: "iso", fallback: true },
      geometry: { type: "Polygon", coordinates: circle(center, r) },
    });
  });
  return { type: "FeatureCollection", features: feats };
}

// ─── 지하철 기반 도달권역 ────────────────────────────────────────
// OSM 노선 그래프(정적) + 도보 접근/하차 반경. GTFS 시간표가 아니므로 '추정치'.
const SUBWAY_URL = "/data/subway_seoul.json";
const WALK_KMH = 4.5;
const DETOUR = 0.75;      // 직선 → 실보행 우회 보정
const BOARD_MAX_M = 1000; // 승차역까지 걸어갈 최대 거리

type SubwayGraph = {
  speedKmh: number; dwellSec: number; transferSec: number;
  stations: { n: string; x: number; y: number }[];
  edges: [number, number, number][];
};
let SUB: SubwayGraph | null = null;
let ADJ: Map<number, [number, number][]> | null = null;

async function subway(signal?: AbortSignal) {
  if (SUB && ADJ) return { g: SUB, adj: ADJ };
  const { sig, done } = withTimeout(5000, signal);
  try {
    const r = await fetch(SUBWAY_URL, { signal: sig });
    if (!r.ok) throw new Error("지하철 그래프 없음");
    SUB = (await r.json()) as SubwayGraph;
    ADJ = new Map();
    for (const [a, b, s] of SUB.edges) {
      if (!ADJ.has(a)) ADJ.set(a, []);
      if (!ADJ.has(b)) ADJ.set(b, []);
      ADJ.get(a)!.push([b, s]);
      ADJ.get(b)!.push([a, s]);
    }
    return { g: SUB, adj: ADJ };
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    console.warn("[지하철] 그래프 로드 실패:", e);
    throw e;
  } finally {
    done();
  }
}

/** 반경 m 원을 폴리곤으로 */
function circle(center: [number, number], m: number, steps = 36): GeoJSON.Position[][] {
  return [ringAround(center[0], center[1], m, steps)];
}
function ringAround(lon: number, lat: number, m: number, steps = 20): GeoJSON.Position[] {
  const dLat = m / 111320;
  const dLon = m / (111320 * Math.cos((lat * Math.PI) / 180));
  const ring: GeoJSON.Position[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return ring;
}

export const TRANSIT_CONTOURS = [10, 20, 30];

/**
 * 지하철 도달권역. 필지에서 도보로 승차 → 다익스트라 → 하차역에서 남은 시간만큼 도보.
 * 폴리곤 = (도달역마다 남은시간 도보버퍼) ∪ (승차 전 도보버퍼) 을 합집합.
 */
export async function transitIsochrone(
  center: [number, number], signal?: AbortSignal
): Promise<{ fc: GeoJSON.FeatureCollection; reached: number; boarded: number; nearest: string } | null> {
  const { g, adj } = await subway(signal);
  const walkSec = (m: number) => (m / DETOUR) / ((WALK_KMH * 1000) / 3600);
  const walkM = (sec: number) => sec * ((WALK_KMH * 1000) / 3600) * DETOUR;

  // 도보로 닿는 승차역
  const dist = new Map<number, number>();
  const pq: [number, number][] = [];
  let nearest = "", nearestD = Infinity;
  g.stations.forEach((s, i) => {
    const d = haversine(center, [s.x, s.y]);
    if (d < nearestD) { nearestD = d; nearest = s.n; }
    if (d <= BOARD_MAX_M) {
      const t = walkSec(d);
      dist.set(i, t);
      pq.push([t, i]);
    }
  });
  const boarded = pq.length;

  const BUDGET = Math.max(...TRANSIT_CONTOURS) * 60;
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0]);
    const [d, u] = pq.shift()!;
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const [v, w] of adj.get(u) ?? []) {
      const nd = d + w;
      if (nd <= BUDGET && nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        pq.push([nd, v]);
      }
    }
  }

  const asc = [...TRANSIT_CONTOURS].sort((a, b) => a - b);
  const feats: GeoJSON.Feature[] = [];
  [...TRANSIT_CONTOURS].sort((a, b) => b - a).forEach((mins) => {
    const budget = mins * 60;
    const polys: [number, number][][][] = [];

    const pair = (r: GeoJSON.Position[]) => r.map((c) => [c[0], c[1]] as [number, number]);

    // 승차 전 도보 — 12분 이상 걸으면 지하철 의미가 없으니 그만큼만
    polys.push([pair(ringAround(center[0], center[1], walkM(Math.min(budget, 12 * 60))))]);

    // 도달역마다: 하차 후 남은 시간 도보 버퍼 (최대 1.1km)
    for (const [i, t] of dist) {
      if (t >= budget) continue;
      const wm = Math.min(1100, walkM(budget - t));
      if (wm < 80) continue;
      const s = g.stations[i];
      polys.push([pair(ringAround(s.x, s.y, wm))]);
    }

    let merged: GeoJSON.Position[][][];
    try {
      merged = polygonClipping
        .union(polys[0] as never, ...(polys.slice(1) as never[]))
        .map((poly) => poly.map((ring) => ring.map((c) => [c[0], c[1]] as GeoJSON.Position)));
    } catch {
      merged = polys;
    }
    feats.push({
      type: "Feature",
      properties: { idx: asc.indexOf(mins), contour: mins, kind: "transit" },
      geometry: { type: "MultiPolygon", coordinates: merged },
    });
  });

  const reached = [...dist.values()].filter((t) => t < BUDGET).length - boarded;
  return { fc: { type: "FeatureCollection", features: feats }, reached: Math.max(0, reached), boarded, nearest };
}
