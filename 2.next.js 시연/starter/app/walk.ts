// 보행 접근성: 주변 정류장·역 탐색(로컬 POI) + 실제 보행 경로(Valhalla)
// 무키 공개 서비스 사용. 실무 전환 시 서울 열린데이터광장 + TMAP 보행자 API로 교체.

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

const VALHALLA = "https://valhalla1.openstreetmap.de/route";
const POI_URL = "/data/poi_seoul.json";

const R = 6371000;
export function haversine(a: [number, number], b: [number, number]) {
  const t = Math.PI / 180;
  const dLat = (b[1] - a[1]) * t, dLon = (b[0] - a[0]) * t;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * t) * Math.cos(b[1] * t) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Valhalla shape(polyline6) 디코드 → [lon,lat][] */
function decodeShape(str: string, precision = 6): [number, number][] {
  let index = 0, lat = 0, lng = 0;
  const out: [number, number][] = [];
  const factor = 10 ** precision;
  while (index < str.length) {
    let b: number, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    out.push([lng / factor, lat / factor]);
  }
  return out;
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

/** 실제 보행 경로 (Valhalla pedestrian routing) */
export async function route(from: [number, number], poi: Poi, signal?: AbortSignal): Promise<Walk | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000); // 8초 타임아웃
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;

  try {
    const r = await fetch(VALHALLA, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locations: [
          { lat: from[1], lon: from[0], type: "break" },
          { lat: poi.lat, lon: poi.lon, type: "break" },
        ],
        costing: "pedestrian",
        directions_options: { units: "kilometers", language: "ko-KR" },
      }),
      signal: combinedSignal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const leg = j?.trip?.legs?.[0];
    if (!leg?.shape) return null;
    return {
      poi,
      meters: Math.round((j.trip.summary.length ?? 0) * 1000),
      seconds: Math.round(j.trip.summary.time ?? 0),
      line: decodeShape(leg.shape),
    };
  } catch (e) {
    if ((e as Error).name === "AbortError" || (e as Error).name === "TimeoutError") {
      console.warn("[Valhalla] 타임아웃/중단:", poi.name);
      return null;
    }
    console.warn("[Valhalla] 경로 실패:", e);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── 등시선(권역) ────────────────────────────────────────────────
const ISOCHRONE = "https://valhalla1.openstreetmap.de/isochrone";

export type IsoMode = "pedestrian" | "bicycle" | "auto";
export const ISO_CONTOURS: Record<IsoMode, number[]> = {
  pedestrian: [5, 10, 15],
  bicycle: [10, 20, 30],
  auto: [10, 20, 30],
};
export const ISO_LABEL: Record<IsoMode, string> = {
  pedestrian: "도보", bicycle: "자전거", auto: "자동차",
};

/** Valhalla 등시선 호출 (타임아웃 10초) */
async function valhallaIsochrone(
  center: [number, number], mode: IsoMode, signal?: AbortSignal
): Promise<GeoJSON.FeatureCollection | null> {
  const mins = ISO_CONTOURS[mode];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;

  try {
    const r = await fetch(ISOCHRONE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locations: [{ lat: center[1], lon: center[0] }],
        costing: mode,
        contours: mins.map((time) => ({ time })),
        polygons: true, denoise: 0.4, generalize: 25,
      }),
      signal: combinedSignal,
    });
    if (!r.ok) return null;
    const fc = (await r.json()) as GeoJSON.FeatureCollection;
    if (!fc?.features?.length) return null;
    const feats: GeoJSON.Feature[] = fc.features
      .map((f) => ({
        ...f,
        properties: { ...f.properties, contour: Number(f.properties?.contour ?? 0) } as GeoJSON.GeoJsonProperties,
      }))
      .sort((a, b) => Number(b.properties!.contour) - Number(a.properties!.contour));
    const order = [...mins].sort((a, b) => a - b);
    for (const f of feats) f.properties!.idx = order.indexOf(Number(f.properties!.contour));
    return { type: "FeatureCollection", features: feats };
  } catch (e) {
    if ((e as Error).name === "AbortError") return null;
    console.warn("[Valhalla] 등시선 실패:", e);
    return null;
  } finally {
    clearTimeout(timeout);
}
}

// ─── 지하철 기반 30분 도달권역 ───────────────────────────────────
// OSM 노선 그래프(정적) + 도보 접근/하차 반경. GTFS 시간표가 아니므로 '추정치'.
const SUBWAY_URL = "/data/subway_seoul.json";
const WALK_KMH = 4.5;
const DETOUR = 0.75;      // 직선 → 실보행 우회 보정
const BOARD_MAX_M = 1000; // 승차역까지 걸어갈 최대 거리

/** Valhalla/ORS 모두 실패 시 로컬 원형 폴백 (도보/자전거/자동차) */
function localIsochroneFallback(center: [number, number], mode: IsoMode): GeoJSON.FeatureCollection {
  const speeds = { pedestrian: 4.5, bicycle: 15, auto: 40 }; // km/h
  const v = speeds[mode];
  const feats: GeoJSON.Feature[] = [];
  const contours = ISO_CONTOURS[mode];
  [...contours].sort((a, b) => b - a).forEach((mins) => {
    const r = (v * 1000 / 60) * mins * 0.7; // 우회율 0.7 반영
    feats.push({
      type: "Feature",
      properties: { idx: contours.indexOf(mins), contour: mins, kind: "walk", fallback: true },
      geometry: { type: "Polygon", coordinates: circle(center, r) },
    });
  });
  return { type: "FeatureCollection", features: feats };
}

type SubwayGraph = {
  speedKmh: number; dwellSec: number; transferSec: number;
  stations: { n: string; x: number; y: number }[];
  edges: [number, number, number][];
};
let SUB: SubwayGraph | null = null;
let ADJ: Map<number, [number, number][]> | null = null;

async function subway(signal?: AbortSignal) {
  if (SUB && ADJ) return { g: SUB, adj: ADJ };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;

  try {
    const r = await fetch(SUBWAY_URL, { signal: combinedSignal });
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
    clearTimeout(timeout);
  }
}

/** 간단한 폴리곤 유니온 (turfs 없이 구현 - 볼록 껍질 근사) */
function unionPolygons(polys: GeoJSON.Position[][][]): GeoJSON.Position[][] {
  if (polys.length <= 1) return polys;
  // 모든 좌표 모아서 볼록 껍질 계산 (Monotone chain)
  const points: [number, number][] = polys.flatMap(p => p[0]).map(c => [c[0], c[1]]);
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  
  const lower: [number, number][] = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = [...lower, ...upper];
  return [hull];
}

/** 반경 m 원을 폴리곤으로 */
function circle(center: [number, number], m: number, steps = 36): GeoJSON.Position[][] {
  const [lon, lat] = center;
  const dLat = m / 111320;
  const dLon = m / (111320 * Math.cos((lat * Math.PI) / 180));
  const ring: GeoJSON.Position[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return [ring];
}

/** 로컬 원형 폴백 (Valhalla/ORS 둘 다 실패 시) */
function localIsochroneFallback(center: [number, number], mode: IsoMode): GeoJSON.FeatureCollection {
  const speeds = { pedestrian: 4.5, bicycle: 15, auto: 40 }; // km/h
  const v = speeds[mode];
  const feats: GeoJSON.Feature[] = [];
  const contours = ISO_CONTOURS[mode];
  [...contours].sort((a, b) => b - a).forEach((mins) => {
    const r = (v * 1000 / 60) * mins * 0.7; // 우회율 0.7 반영
    feats.push({
      type: "Feature",
      properties: { idx: contours.indexOf(mins), contour: mins, kind: "walk", fallback: true },
      geometry: { type: "Polygon", coordinates: circle(center, r) },
    });
  });
  return { type: "FeatureCollection", features: feats };
}

export const TRANSIT_CONTOURS = [10, 20, 30];

/** 지하철 기반 도달권역 (10/20/30분). GTFS 시간표가 아니므로 '추정치'. */
export async function transitIsochrone(
  center: [number, number], signal?: AbortSignal
): Promise<{ fc: GeoJSON.FeatureCollection; reached: number; boarded: number; nearest: string } | null> {
  try {
    const { g, adj } = await subway(signal);
    const walkSec = (m: number) => (m / DETOUR) / ((WALK_KMH * 1000) / 3600);

    // 도보로 닿는 승차역
    const dist = new Map<number, number>();
    let pq: [number, number][] = [];
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

    const BUDGET = 30 * 60;
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

    const feats: GeoJSON.Feature[] = [];
    // 10/20/30분 각각의 등시선 표현 — 각 분수별로 폴리곤들을 유니온해서 하나의 권역으로
    [...TRANSIT_CONTOURS].sort((a, b) => b - a).forEach((mins) => {
      const idx = TRANSIT_CONTOURS.indexOf(mins);
      const budget = mins * 60;
      
      // 이 시간 예산 내에 도달하는 모든 폴리곤 수집
      const allPolys: GeoJSON.Position[][][] = [];
      
      // 필지 주변 도보 권역
      const r0 = Math.min(2500, (budget / 3600) * WALK_KMH * 1000 * DETOUR);
      allPolys.push(circle(center, r0));
      
      // 각 역에서 하차 후 남은 시간만큼 도보 권역
      for (const [i, t] of dist) {
        if (t >= budget) continue;
        const r = Math.min(1200, ((budget - t) / 3600) * WALK_KMH * 1000 * DETOUR);
        if (r < 60) continue;
        const s = g.stations[i];
        allPolys.push(circle([s.x, s.y], r, 24));
      }
      
      // 같은 시간대의 모든 폴리곤을 유니온해서 하나의 권역으로
      const unioned = unionPolygons(allPolys);
      for (const poly of unioned) {
        feats.push({
          type: "Feature",
          properties: { idx, contour: mins, kind: "transit" },
          geometry: { type: "Polygon", coordinates: poly },
        });
      }
    });

    return { fc: { type: "FeatureCollection", features: feats }, reached: dist.size, boarded, nearest };
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    console.warn("[지하철 30분권] 실패, 폴백 사용:", e);
    return { fc: localIsochroneFallback(center, "pedestrian"), reached: 0, boarded: 0, nearest: "" };
  }
}

const MATRIX = "https://valhalla1.openstreetmap.de/sources_to_targets";
const ORS_MATRIX = "/api/ors/matrix?action=matrix";

/** 후보들의 실제 보행거리를 한 번에 계산 (직선 최단 ≠ 보행 최단 이므로 필수) */
async function matrix(from: [number, number], cands: Poi[], signal?: AbortSignal) {
  // 1) Valhalla 시도
  const valhallaResult = await valhallaMatrix(from, cands, signal);
  if (valhallaResult) return valhallaResult;
  // 2) ORS 폴백
  return orsMatrix(from, cands, signal);
}

async function valhallaMatrix(from: [number, number], cands: Poi[], signal?: AbortSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;

  try {
    const r = await fetch(MATRIX, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [{ lat: from[1], lon: from[0] }],
        targets: cands.map((p) => ({ lat: p.lat, lon: p.lon })),
        costing: "pedestrian",
        units: "kilometers",
      }),
      signal: combinedSignal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const row = j?.sources_to_targets?.[0];
    if (!Array.isArray(row)) return null;
    return row.map((c: { distance?: number; time?: number }) => ({
      meters: c?.distance != null ? c.distance * 1000 : Infinity,
      seconds: c?.time ?? Infinity,
    }));
  } catch (e) {
    if ((e as Error).name === "AbortError") return null;
    console.warn("[Valhalla] 매트릭스 실패:", e);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function orsMatrix(from: [number, number], cands: Poi[], signal?: AbortSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;

  try {
    const r = await fetch(ORS_MATRIX, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locations: [[from[0], from[1]], ...cands.map(p => [p.lon, p.lat])],
        profile: "foot-walking",
        sources: [0],
        destinations: cands.map((_, i) => i + 1),
        metrics: ["distance", "duration"],
      }),
      signal: combinedSignal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const distances = j?.distances?.[0] ?? [];
    const durations = j?.durations?.[0] ?? [];
    return cands.map((_, i) => ({
      meters: distances[i] ?? Infinity,
      seconds: durations[i] ?? Infinity,
    }));
  } catch (e) {
    if ((e as Error).name === "AbortError") return null;
    console.warn("[ORS] 매트릭스 실패:", e);
    return null;
  } finally {
    clearTimeout(timeout);
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