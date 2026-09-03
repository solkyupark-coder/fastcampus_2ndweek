import polygonClipping from "polygon-clipping";
import turfBuffer from "@turf/buffer";
import turfArea from "@turf/area";
import { polygon as turfPolygon } from "@turf/helpers";

// 규모검토(개략). 인허가 판단이 아니라 '조회한 값으로 계산할 수 있는 범위'만 낸다.
// 대지안의 공지·건축선 후퇴·가로구역별 최고높이·지구단위계획은 반영하지 않는다.

export type Zone = {
  name: string;
  bcr: number;   // 법정 건폐율 %
  far: number;   // 법정 용적률 %
  heightNote: string;
};

// 서울특별시 도시계획 조례 기준 상한
const ZONES: [RegExp, Omit<Zone, "name">][] = [
  [/제1종전용주거/, { bcr: 50, far: 100, heightNote: "2층 이하(조례 확인)" }],
  [/제2종전용주거/, { bcr: 40, far: 120, heightNote: "" }],
  [/제1종일반주거/, { bcr: 60, far: 150, heightNote: "4층 이하" }],
  [/제2종일반주거.*7층|7층.*제2종일반주거/, { bcr: 60, far: 200, heightNote: "7층 이하" }],
  [/제2종일반주거/, { bcr: 60, far: 200, heightNote: "" }],
  [/제3종일반주거/, { bcr: 50, far: 250, heightNote: "" }],
  [/준주거/, { bcr: 60, far: 400, heightNote: "" }],
  [/중심상업/, { bcr: 60, far: 1000, heightNote: "" }],
  [/일반상업/, { bcr: 60, far: 800, heightNote: "" }],
  [/근린상업/, { bcr: 60, far: 600, heightNote: "" }],
  [/유통상업/, { bcr: 60, far: 600, heightNote: "" }],
  [/준공업/, { bcr: 60, far: 400, heightNote: "" }],
  [/일반주거/, { bcr: 60, far: 200, heightNote: "종 미상 — 제2종 가정" }],
];

export function zoneOf(uz: string): Zone | null {
  if (!uz) return null;
  for (const [re, v] of ZONES) if (re.test(uz)) return { name: uz, ...v };
  return null;
}

export type UnitCase = {
  label: string;      // 21㎡형
  exclusive: number;  // 전용면적 ㎡
  units: number;      // 세대수
  parking: number;    // 법정 주차대수
  rule: string;       // 근거
};

export type Scale = {
  zone: Zone;
  platArea: number;
  maxArch: number;     // 최대 건축면적
  maxTot: number;      // 최대 연면적(지상)
  floors: number;      // 층수 추정
  cur?: { arch: number | null; tot: number | null; bcr: number | null; vlRat: number | null };
  spare?: { arch: number; tot: number };   // 여유
  cases: UnitCase[];
  parkingDagagu: number;   // 다가구(단독) 기준 부설주차
  sunlight: string;
};

const EFF = 0.8;  // 전용률(공용 제외) 가정 — 연구 표4-35 기준 약 0.84

/** 다가구주택(단독주택)은 주차장법 시행령 별표1: 150㎡ 초과분 100㎡당 1대 */
export function parkingDetached(totArea: number) {
  if (totArea <= 50) return 0;
  if (totArea <= 150) return 1;
  return Math.ceil(1 + (totArea - 150) / 100);
}

/** 세대당 주차 계수 — 도시형생활주택 원룸형 / 공동주택 */
function unitFactor(excl: number): [number, string] {
  if (excl < 30) return [0.5, "도시형생활주택 원룸형(전용 30㎡ 미만) 0.5대/세대"];
  if (excl < 50) return [0.6, "도시형생활주택 원룸형(전용 30~50㎡) 0.6대/세대"];
  if (excl <= 60) return [0.7, "공동주택 전용 60㎡ 이하 0.7대/세대"];
  return [1.0, "공동주택 전용 60㎡ 초과 1대/세대"];
}

export function scaleReview(
  platArea: number,
  uz: string,
  cur?: { arch: number | null; tot: number | null; bcr: number | null; vlRat: number | null }
): Scale | null {
  const zone = zoneOf(uz);
  if (!zone || !(platArea > 0)) return null;

  const maxArch = +(platArea * zone.bcr / 100).toFixed(2);
  const maxTot = +(platArea * zone.far / 100).toFixed(2);
  const floors = +(maxTot / maxArch).toFixed(1);

  const cases: UnitCase[] = [21, 30, 45].map((excl) => {
    const units = Math.floor((maxTot * EFF) / excl);
    const [f, rule] = unitFactor(excl);
    return { label: `${excl}㎡형`, exclusive: excl, units, parking: Math.ceil(units * f), rule };
  });

  return {
    zone, platArea, maxArch, maxTot, floors, cur,
    spare: cur ? {
      arch: +(maxArch - (cur.arch ?? 0)).toFixed(2),
      tot: +(maxTot - (cur.tot ?? 0)).toFixed(2),
    } : undefined,
    cases,
    parkingDagagu: parkingDetached(maxTot),
    sunlight: "정북 인접대지경계선: 높이 9m 이하 1.5m 이상, 9m 초과 부분은 그 높이의 1/2 이상 이격",
  };
}

/** 폴리곤을 중심 기준으로 면적비 ratio 만큼 축소 (건폐율 매스용) */
export function shrink(coords: GeoJSON.Position[][], ratio: number): GeoJSON.Position[][] {
  const k = Math.sqrt(Math.max(0, Math.min(1, ratio)));
  return coords.map((ring) => {
    let cx = 0, cy = 0;
    for (const [x, y] of ring) { cx += x; cy += y; }
    cx /= ring.length; cy /= ring.length;
    return ring.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k] as GeoJSON.Position);
  });
}

export const FLOOR_H = 3;   // 층고 가정 3m

/** 폴리곤 면적(㎡). 위경도 → 국지 평면 근사 후 신발끈 공식 */
export function polyArea(coords: GeoJSON.Position[][]): number {
  const ring = coords[0];
  if (!ring || ring.length < 4) return 0;
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const my = 110540;
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
    a += x1 * mx * (y2 * my) - x2 * mx * (y1 * my);
  }
  return Math.abs(a / 2);
}

export type MergeParcel = { pnu: string; addr: string; area: number };

export type MergeReview = {
  zone: Zone;
  n: number;
  sumArea: number;
  floors: number;
  /** 개별 개발: 필지마다 코어(계단·홀) 중복 */
  sep: { maxTot: number; core: number; usable: number; units: number };
  /** 합필 개발: 코어 1개 + 엘리베이터 */
  mrg: { maxTot: number; core: number; usable: number; units: number; evOk: boolean };
  gainArea: number;
  gainUnits: number;
};

const CORE_STAIR = 20;   // 계단+홀 코어 ㎡/층
const CORE_EV = 15;      // 엘리베이터 추가 ㎡/층
const EV_MIN_AREA = 330; // 엘리베이터 설치가 현실적인 최소 대지(㎡) — 가정

/**
 * 합필 효과(개략). 건폐·용적 상한은 면적에 선형이라 총량은 같다.
 * 차이는 '코어 중복'에서 난다: 개별이면 필지마다 계단·홀이 들어가고,
 * 합필하면 코어 하나로 통합되며 엘리베이터·커뮤니티도 성립한다.
 */
export function mergeReview(parcels: MergeParcel[], uz: string, unitSize = 21): MergeReview | null {
  const zone = zoneOf(uz);
  if (!zone || parcels.length < 2) return null;

  const sumArea = parcels.reduce((s, p) => s + p.area, 0);
  const floors = zone.far / zone.bcr;

  // 개별 개발
  let sepTot = 0, sepCore = 0;
  for (const p of parcels) {
    sepTot += p.area * zone.far / 100;
    sepCore += CORE_STAIR * floors;          // 필지마다 코어 1개
  }
  const sepUsable = Math.max(0, sepTot - sepCore);

  // 합필 개발
  const mrgTot = sumArea * zone.far / 100;
  const evOk = sumArea >= EV_MIN_AREA;
  const mrgCore = (CORE_STAIR + (evOk ? CORE_EV : 0)) * floors;
  const mrgUsable = Math.max(0, mrgTot - mrgCore);

  const sepUnits = Math.floor(sepUsable / unitSize);
  const mrgUnits = Math.floor(mrgUsable / unitSize);

  return {
    zone, n: parcels.length, sumArea: +sumArea.toFixed(1), floors: +floors.toFixed(1),
    sep: { maxTot: +sepTot.toFixed(1), core: +sepCore.toFixed(1), usable: +sepUsable.toFixed(1), units: sepUnits },
    mrg: { maxTot: +mrgTot.toFixed(1), core: +mrgCore.toFixed(1), usable: +mrgUsable.toFixed(1), units: mrgUnits, evOk },
    gainArea: +(mrgUsable - sepUsable).toFixed(1),
    gainUnits: mrgUnits - sepUnits,
  };
}

// ─── 정북일조 사선 ────────────────────────────────────────────────
// 건축법 시행령 제86조 제1항
//   전용주거지역·일반주거지역에서 정북방향 인접 대지경계선으로부터
//     · 높이 H0 이하인 부분      : 1.5m 이상
//     · 높이 H0 를 초과하는 부분 : 해당 부분 높이의 1/2 이상
//
//   H0 는 2023년 개정으로 9m → 10m 로 올랐다.
//   단열 강화로 층고가 두꺼워져 9m 안에 3개층을 넣기 어렵다는 현장 의견이 반영된 것.
export const SUNLIGHT_BASE = { before: 9, after: 10 } as const;
export type SunRule = keyof typeof SUNLIGHT_BASE;

export const SUN_MIN_SETBACK = 1.5;

/** 높이 h(m) 지점에 필요한 정북 이격거리(m) */
export function setbackAt(h: number, rule: SunRule): number {
  const H0 = SUNLIGHT_BASE[rule];
  return h <= H0 ? SUN_MIN_SETBACK : h / 2;
}

/** 위도에서 미터 → 경위도 도(degree) */
const mToLat = (m: number) => m / 110540;

/**
 * 폴리곤을 북쪽 한계선(yLim)으로 잘라낸다. (Sutherland–Hodgman 반평면 클리핑)
 * 정북 인접대지경계선은 필지의 최북단 변으로 근사한다.
 */
export function clipNorth(coords: GeoJSON.Position[][], yLim: number): GeoJSON.Position[][] {
  const out: GeoJSON.Position[][] = [];
  for (const ring of coords) {
    const kept: GeoJSON.Position[] = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
      const in1 = y1 <= yLim, in2 = y2 <= yLim;
      if (in1) kept.push([x1, y1]);
      if (in1 !== in2) {
        const t = (yLim - y1) / (y2 - y1);
        kept.push([x1 + (x2 - x1) * t, yLim]);
      }
    }
    if (kept.length >= 3) { kept.push(kept[0]); out.push(kept); }
  }
  return out;
}

/** 폴리곤의 최북단 위도 */
export function northEdge(coords: GeoJSON.Position[][]): number {
  let y = -90;
  for (const ring of coords) for (const p of ring) if (p[1] > y) y = p[1];
  return y;
}

/**
 * 층 상단 높이 h 에서, 정북일조를 지키도록 잘라낸 층 바닥면.
 * 잘라내고 남는 게 없으면 null (그 높이에는 지을 수 없다).
 */
export function sunlightFloor(
  coords: GeoJSON.Position[][], h: number, rule: SunRule
): GeoJSON.Position[][] | null {
  const yN = northEdge(coords);
  const yLim = yN - mToLat(setbackAt(h, rule));
  const clipped = clipNorth(coords, yLim);
  return clipped.length ? clipped : null;
}

// ─── 층수를 정수로 놓고 역산하는 규모검토 ─────────────────────────
// 건폐율과 용적률은 동시에 걸린다.
//   층당 바닥 = min( 대지×건폐율,  대지×용적률 ÷ 층수 )
// 층수가 적으면 건폐율에, 많으면 용적률에 걸린다.
// far/bcr 을 올림한 층수에서 용적률을 100% 쓴다.

export type FloorPlan = {
  floors: number;        // 층수(정수)
  perFloor: number;      // 층당 바닥면적 ㎡
  totArea: number;       // 총 연면적 ㎡
  bcrUsed: number;       // 실현 건폐율 %
  farUsed: number;       // 실현 용적률 %
  farRatio: number;      // 용적률 소진율 % (100이면 다 씀)
  limitedBy: "건폐율" | "용적률" | "둘 다";
  height: number;        // 층수 × 층고
};

export function floorPlan(platArea: number, zone: Zone, floors: number): FloorPlan {
  const byBcr = platArea * zone.bcr / 100;          // 건폐율 한계
  const byFar = platArea * zone.far / 100 / floors; // 용적률을 층수로 나눈 값
  const perFloor = Math.min(byBcr, byFar);
  const totArea = perFloor * floors;

  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const limitedBy: FloorPlan["limitedBy"] =
    near(byBcr, byFar) ? "둘 다" : byBcr < byFar ? "건폐율" : "용적률";

  return {
    floors,
    perFloor: +perFloor.toFixed(2),
    totArea: +totArea.toFixed(2),
    bcrUsed: +(perFloor / platArea * 100).toFixed(2),
    farUsed: +(totArea / platArea * 100).toFixed(2),
    farRatio: +(totArea / (platArea * zone.far / 100) * 100).toFixed(1),
    limitedBy,
    height: +(floors * FLOOR_H).toFixed(1),
  };
}

/** 용적률을 100% 쓰는 최소 층수 */
export function bestFloors(zone: Zone): number {
  return Math.max(1, Math.ceil(zone.far / zone.bcr));
}

/**
 * 합필: 필지 폴리곤들을 하나의 대지 경계로 합친다.
 * 인접한 필지끼리는 공유하는 변이 사라지고 바깥 윤곽만 남는다.
 */
export function unionParcels(polys: GeoJSON.Position[][][]): GeoJSON.Position[][][] {
  if (!polys.length) return [];
  if (polys.length === 1) return [polys[0]];
  try {
    const rings = polys.map((p) => [p.map((r) => r.map((c) => [c[0], c[1]] as [number, number]))]);
    const out = polygonClipping.union(
      rings[0] as never,
      ...(rings.slice(1) as never[])
    );
    // MultiPolygon → Polygon[] 로 펴서 돌려준다
    return out.map((poly) => poly.map((ring) => ring.map((c) => [c[0], c[1]] as GeoJSON.Position)));
  } catch (e) {
    console.warn("합필 union 실패 — 개별 폴리곤으로 대체", e);
    return polys;
  }
}

// ─── 대지 경계에서 안쪽으로 offset ────────────────────────────────
// 건축면적은 '건폐율만큼 축소'가 아니라 '경계에서 이격한 결과'로 정해진다.
//   민법 제242조   경계로부터 0.5m 이상
//   대지안의 공지  건축조례 (용도·규모별)
//   정북일조       인접대지경계선 이격
// 이격해서 남은 면적이 건폐율 상한을 넘으면, 그때 건폐율이 걸린다.

export type Footprint = {
  coords: GeoJSON.Position[][][];  // offset 결과 (여러 조각일 수 있음)
  area: number;                    // 건축면적 ㎡
  setback: number;                 // 실제 적용된 이격 m
  limitedBy: "이격거리" | "건폐율";
  bcrUsed: number;                 // 실현 건폐율 %
};

const asFeature = (coords: GeoJSON.Position[][]) =>
  turfPolygon(coords as number[][][]);

/** 폴리곤 여러 개를 안쪽으로 d(m) offset. 사라지면 빈 배열. */
function offsetIn(polys: GeoJSON.Position[][][], d: number): GeoJSON.Position[][][] {
  if (d <= 0) return polys;
  const out: GeoJSON.Position[][][] = [];
  for (const poly of polys) {
    try {
      const b = turfBuffer(asFeature(poly), -d, { units: "meters" });
      if (!b) continue;
      const g = b.geometry;
      if (g.type === "Polygon") out.push(g.coordinates as GeoJSON.Position[][]);
      else if (g.type === "MultiPolygon") for (const q of g.coordinates) out.push(q as GeoJSON.Position[][]);
    } catch { /* 너무 좁아 사라진 경우 */ }
  }
  return out;
}

const areaOf = (polys: GeoJSON.Position[][][]) =>
  polys.reduce((a, p) => { try { return a + turfArea(asFeature(p)); } catch { return a; } }, 0);

/**
 * 이격거리 setback 으로 offset 한 건축가능영역.
 * 그 면적이 건폐율 상한을 넘으면, 상한에 닿을 때까지 이격을 더 준다(이분탐색).
 */
export function footprintOf(
  site: GeoJSON.Position[][][], siteArea: number, bcr: number, setback: number
): Footprint {
  const cap = siteArea * bcr / 100;

  let coords = offsetIn(site, setback);
  let area = areaOf(coords);

  if (area <= cap) {
    return {
      coords, area: +area.toFixed(2), setback,
      limitedBy: "이격거리",
      bcrUsed: +(area / siteArea * 100).toFixed(2),
    };
  }

  // 건폐율에 걸린다 — 이격을 더 줘서 상한에 맞춘다
  let lo = setback, hi = setback + 20;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const c = offsetIn(site, mid);
    const a = areaOf(c);
    if (a > cap) lo = mid; else { hi = mid; coords = c; area = a; }
  }
  return {
    coords, area: +area.toFixed(2), setback: +hi.toFixed(2),
    limitedBy: "건폐율",
    bcrUsed: +(area / siteArea * 100).toFixed(2),
  };
}

// ─── 사업 유형별 용적률·주차 ──────────────────────────────────────
// 근거는 국가법령정보 API 로 받은 조문 원문이다.
//   서울특별시 도시계획 조례 제48조   용도지역별 용적률
//   같은 조례 제51조제1항제1호        임대주택 용적률 완화 (임대의무기간별)
//   같은 조례 제50조제2호마목          준공업지역에서 시장·LH·SH 직접 건설 시 400%
//   주차장법 시행령 별표1              부설주차장 설치기준

export type BizType = {
  id: string;
  name: string;
  /** 용적률 완화 배수 (1.2 = 제48조 용적률의 20% 추가) */
  farMul: number;
  /** 준공업지역 등에서 고정 용적률을 쓰는 경우 */
  farFixed?: { zone: RegExp; far: number };
  /** 주차 산정 방식 */
  parking:
    | { kind: "perArea"; per: number }            // 시설면적 N㎡당 1대
    | { kind: "perUnit"; table: [number, number][] }  // [전용면적 상한, 세대당 대수]
    | { kind: "detached" };                       // 주차장법 별표1 단독주택
  note: string;
  law: string;
};

export const BIZ_TYPES: BizType[] = [
  {
    id: "general",
    name: "일반 신축",
    farMul: 1,
    parking: { kind: "perUnit", table: [[30, 0.5], [50, 0.6], [60, 0.7], [Infinity, 1.0]] },
    note: "완화 없음",
    law: "서울시 도시계획 조례 §48",
  },
  {
    id: "rent20",
    name: "임대주택 20년↑",
    farMul: 1.2,
    parking: { kind: "perUnit", table: [[30, 0.5], [50, 0.6], [60, 0.7], [Infinity, 1.0]] },
    note: "용적률 20% 완화 — LH 매입임대가 여기 해당",
    law: "서울시 도시계획 조례 §51①1가",
  },
  {
    id: "rent10",
    name: "임대주택 10년↑",
    farMul: 1.15,
    parking: { kind: "perUnit", table: [[30, 0.5], [50, 0.6], [60, 0.7], [Infinity, 1.0]] },
    note: "용적률 15% 완화",
    law: "서울시 도시계획 조례 §51①1나",
  },
  {
    id: "rent5",
    name: "임대주택 5년↑",
    farMul: 1.1,
    parking: { kind: "perUnit", table: [[30, 0.5], [50, 0.6], [60, 0.7], [Infinity, 1.0]] },
    note: "용적률 10% 완화",
    law: "서울시 도시계획 조례 §51①1다",
  },
  {
    id: "dorm",
    name: "임대형기숙사",
    farMul: 1.2,
    farFixed: { zone: /준공업/, far: 400 },
    parking: { kind: "perArea", per: 200 },
    note: "주차 시설면적 200㎡당 1대 — 주거 유형 중 가장 완화. 준공업에서 LH·SH 직접 건설 시 400%",
    law: "주차장법 시행령 별표1 · 서울시 도시계획 조례 §50②마",
  },
  {
    id: "officetel",
    name: "오피스텔",
    farMul: 1,
    parking: { kind: "perUnit", table: [[30, 0.5], [60, 0.8], [Infinity, 1.0]] },
    note: "주거가 아니라 업무시설 — 임대주택 용적률 완화 대상 아님. 주차는 지자체 조례 확인 필요",
    law: "주차장법 시행령 별표1 · 서울시 주차장 조례",
  },
  {
    id: "office",
    name: "업무시설(오피스)",
    farMul: 1,
    parking: { kind: "perArea", per: 100 },
    note: "시설면적 100㎡당 1대. 주거지역에서는 용도 제한을 먼저 확인해야 한다",
    law: "주차장법 시행령 별표1",
  },
  {
    id: "dagagu",
    name: "다가구(단독)",
    farMul: 1,
    parking: { kind: "detached" },
    note: "150㎡ 초과 100㎡당 1대",
    law: "주차장법 시행령 별표1",
  },
];

/** 사업 유형을 반영한 용적률 상한 (%) */
export function farFor(zone: Zone, biz: BizType): number {
  if (biz.farFixed && biz.farFixed.zone.test(zone.name)) return biz.farFixed.far;
  return Math.round(zone.far * biz.farMul);
}

/** 사업 유형별 법정 주차대수 */
export function parkingFor(biz: BizType, totArea: number, units: number, exclusive: number): number {
  const p = biz.parking;
  if (p.kind === "perArea") return Math.ceil(totArea / p.per);
  if (p.kind === "detached") return parkingDetached(totArea);
  for (const [cap, per] of p.table) if (exclusive <= cap) return Math.ceil(units * per);
  return Math.ceil(units);
}

// ─── 정북 인접대지경계선 자동 판정 ────────────────────────────────
// 건축법 시행령 제86조
//   ②3  정북방향 인접 대지가 전용·일반주거지역이 아니면 제1항을 적용하지 않는다
//   ⑥   사이에 도로·공원·철도·하천·광장·공공공지·녹지·유수지·유원지가 있으면
//        그 반대편 대지경계선을 인접 대지경계선으로 한다
//
// VWorld 연속지적의 jibun 끝 글자가 지목이다. ("1573-28대", "1707공")

/** §86⑥ 에 해당하는 지목 (사이에 있으면 경계선을 반대편으로 민다) */
const PASS_JIMOK: Record<string, string> = {
  도: "도로", 공: "공원", 천: "하천", 철: "철도용지", 광: "광장",
  녹: "녹지", 유: "유지", 구: "구거", 제: "제방", 원: "유원지",
};

export const jimokOf = (jibun: string) => (jibun || "").replace(/[\d\-\s]/g, "").slice(0, 1);

export type NorthSide = {
  /** 정북 인접대지경계선의 위도 */
  boundaryY: number;
  /** 사이에 낀 시설들 (도로 등) */
  passed: { jimok: string; name: string; widthM: number }[];
  /** 인접 대지를 찾았는지 */
  found: boolean;
  note: string;
};

const inRing = (x: number, y: number, ring: GeoJSON.Position[]) => {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inPoly = (x: number, y: number, poly: GeoJSON.Position[][]) =>
  poly.length ? inRing(x, y, poly[0]) && !poly.slice(1).some((h) => inRing(x, y, h)) : false;

/**
 * 선택 대지의 정북쪽을 훑어 인접 대지경계선을 찾는다.
 * 도로·공원 같은 시설을 만나면 건너뛰고(§86⑥), 대지를 만나면 거기서 멈춘다.
 */
export function northBoundary(
  site: GeoJSON.Position[][][],
  neighbors: { poly: GeoJSON.Position[][]; jibun: string }[],
  maxScanM = 80
): NorthSide {
  // 대지의 북단, 그리고 x 중심
  let yN = -90, xs: number[] = [];
  for (const p of site) for (const r of p) for (const c of r) { if (c[1] > yN) yN = c[1]; xs.push(c[0]); }
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;

  const stepM = 1;
  const dLat = stepM / 110540;
  const passed: NorthSide["passed"] = [];
  let cur: { jimok: string; name: string; startY: number } | null = null;

  for (let k = 1; k * stepM <= maxScanM; k++) {
    const y = yN + k * dLat;
    const hit = neighbors.find((n) => inPoly(cx, y, n.poly));

    if (!hit) {                       // 빈 틈 — 필지 사이 경계선 위
      continue;
    }
    const jm = jimokOf(hit.jibun);
    const pass = PASS_JIMOK[jm];

    if (pass) {                        // 도로·공원 등 — 건너뛴다
      if (!cur || cur.jimok !== jm) {
        if (cur) passed.push({ jimok: cur.jimok, name: PASS_JIMOK[cur.jimok] ?? cur.jimok,
                               widthM: Math.round((y - cur.startY) * 110540) });
        cur = { jimok: jm, name: pass, startY: y };
      }
      continue;
    }

    // 대지를 만났다 — 여기가 인접 대지경계선
    if (cur) passed.push({ jimok: cur.jimok, name: PASS_JIMOK[cur.jimok] ?? cur.jimok,
                           widthM: Math.round((y - cur.startY) * 110540) });
    return {
      boundaryY: y,
      passed,
      found: true,
      note: passed.length
        ? `북측 ${passed.map((p) => `${p.name} ${p.widthM}m`).join(" + ")} 건너 대지 (시행령 §86⑥)`
        : "북측이 인접 대지",
    };
  }

  if (cur) passed.push({ jimok: cur.jimok, name: PASS_JIMOK[cur.jimok] ?? cur.jimok,
                         widthM: Math.round((yN + maxScanM / 110540 - cur.startY) * 110540) });
  return {
    boundaryY: yN,
    passed,
    found: false,
    note: `북측 ${maxScanM}m 안에서 인접 대지를 찾지 못함 — 필지 북단으로 근사`,
  };
}

/** 인접대지경계선(yBoundary)을 기준으로 높이 h 에서의 층 바닥 */
export function sunlightFloorAt(
  coords: GeoJSON.Position[][], h: number, rule: SunRule, yBoundary: number
): GeoJSON.Position[][] | null {
  const yLim = yBoundary - setbackAt(h, rule) / 110540;
  const clipped = clipNorth(coords, yLim);
  return clipped.length ? clipped : null;
}

// ─── 필로티 주차 ──────────────────────────────────────────────────
// 필로티(1층을 비워 주차장으로 쓰는 것)는 바닥면적에 산입하지 않는다.
//   건축법 시행령 제119조제1항제3호 — 공중의 통행·차량 통행·주차에 전용되는
//   필로티는 바닥면적에서 제외
// 따라서 용적률 산정 연면적은 '주거층'만 세고, 층수는 하나 더 올릴 수 있다.

/** 주차 1대에 필요한 실효 면적(㎡) — 주차구획 12.5 + 차로·기둥 몫 */
export const PARK_AREA_PER_CAR = 32;
/** 필로티에서 기둥·코어·계단이 먹는 비율 */
export const PILOTI_EFF = 0.85;

export type Parking = {
  required: number;        // 법정 주차대수
  pilotiArea: number;      // 필로티 유효면적 ㎡
  pilotiCars: number;      // 필로티로 댈 수 있는 대수
  shortage: number;        // 필로티만으로 부족한 대수
  basementFloors: number;  // 필요한 지하 주차층 수
  basementCars: number;    // 지하로 대는 대수
  ok: boolean;
  perCar: number;
  note: string;
};

export function parkingPlan(
  biz: BizType,
  footArea: number,      // 건축면적(1층 바닥)
  totArea: number,       // 용적률 산정 연면적(주거층 합)
  units: number,
  exclusive: number,
  piloti: boolean
): Parking {
  const required = parkingFor(biz, totArea, units, exclusive);
  const pilotiArea = piloti ? +(footArea * PILOTI_EFF).toFixed(1) : 0;
  const pilotiCars = Math.floor(pilotiArea / PARK_AREA_PER_CAR);
  const shortage = Math.max(0, required - pilotiCars);

  // 부족분은 지하로 내린다. 지하 한 층도 필로티와 같은 바닥을 쓴다고 본다.
  // 지하주차장은 바닥면적에 들어가지만 용적률 산정 연면적에서는 제외된다.
  //   건축법 시행령 제119조제1항제4호 — 지하층 면적은 용적률 산정 연면적에서 제외
  const perFloorCars = Math.max(1, Math.floor(footArea * PILOTI_EFF / PARK_AREA_PER_CAR));
  const basementFloors = shortage > 0 ? Math.ceil(shortage / perFloorCars) : 0;
  const basementCars = Math.min(shortage, basementFloors * perFloorCars);

  return {
    required, pilotiArea, pilotiCars, shortage, basementFloors, basementCars,
    ok: piloti ? pilotiCars + basementCars >= required : false,
    perCar: PARK_AREA_PER_CAR,
    note: !piloti
      ? "필로티를 켜면 1층 주차 가능 대수를 계산합니다"
      : shortage === 0
        ? `필로티 1층으로 법정 ${required}대 충족`
        : `필로티 ${pilotiCars}대 + 지하 ${basementFloors}개층 ${basementCars}대 = ${pilotiCars + basementCars}대`,
  };
}

// ─── 주차구획 배치 ────────────────────────────────────────────────
// 주차장법 시행규칙 제3조 — 평행주차 외 일반형 주차단위구획
//   너비 2.5m 이상 × 길이 5.0m 이상
// 직각주차 차로 너비 6.0m (같은 규칙 제6조)
//
// 필로티 바닥(건축면적 폴리곤) 안에 [주차 5m][차로 6m][주차 5m] … 로 열을 깔고,
// 각 열에서 2.5m 간격으로 구획을 놓는다. 폴리곤 안에 온전히 들어가는 것만 센다.

export const STALL_W = 2.5;
export const STALL_L = 5.0;
export const AISLE_W = 6.0;

export type Stall = { poly: GeoJSON.Position[] };
export type Aisle = { poly: GeoJSON.Position[] };

const M2LAT = 1 / 110540;
const m2lon = (lat: number) => 1 / (111320 * Math.cos((lat * Math.PI) / 180));

/** 점이 폴리곤(구멍 포함) 안에 있는가 */
function pointIn(x: number, y: number, poly: GeoJSON.Position[][]): boolean {
  const ring = (r: GeoJSON.Position[]) => {
    let inside = false;
    for (let i = 0, j = r.length - 2; i < r.length - 1; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  if (!poly.length || !ring(poly[0])) return false;
  return !poly.slice(1).some(ring);
}

/**
 * 필로티 바닥에 주차구획을 깐다.
 * 대지 형상이 제각각이라 정밀 배치는 아니고, '몇 대가 실제로 들어가는가' 를 눈으로 보는 용도다.
 * 각도를 여러 개 돌려보고 가장 많이 들어가는 배치를 고른다.
 */
export function layoutStalls(
  foot: GeoJSON.Position[][][], maxCars = 999
): { stalls: Stall[]; aisles: Aisle[]; angleDeg: number } {
  let best: { stalls: Stall[]; aisles: Aisle[]; angleDeg: number } = { stalls: [], aisles: [], angleDeg: 0 };

  // 대지 중심·위도 (미터↔도 환산 기준)
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  for (const p of foot) for (const r of p) for (const c of r) {
    if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1];
  }
  if (minX > maxX) return best;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const kx = m2lon(cy), ky = M2LAT;

  // 도 → 로컬 미터
  const toM = (c: GeoJSON.Position): [number, number] => [(c[0] - cx) / kx, (c[1] - cy) / ky];
  const toDeg = (x: number, y: number): GeoJSON.Position => [cx + x * kx, cy + y * ky];

  const footM = foot.map((p) => p.map((r) => r.map(toM)));
  const inFootM = (x: number, y: number) => footM.some((p) => pointIn(x, y, p as GeoJSON.Position[][]));

  const halfW = ((maxX - minX) / kx) / 2 + 5;
  const halfH = ((maxY - minY) / ky) / 2 + 5;
  const R = Math.hypot(halfW, halfH);

  for (let a = 0; a < 180; a += 15) {
    const th = (a * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th);
    const rot = (x: number, y: number): [number, number] => [x * cos - y * sin, x * sin + y * cos];

    const stalls: Stall[] = [];
    const aisles: Aisle[] = [];
    const pitch = STALL_L * 2 + AISLE_W;      // [주차 5m][차로 6m][주차 5m]

    const box = (x0: number, y0: number, w: number, h: number) => {
      const rc = ([[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]] as [number, number][])
        .map(([x, y]) => rot(x, y));
      return { rc, poly: [...rc.map(([x, y]) => toDeg(x, y)), toDeg(rc[0][0], rc[0][1])] };
    };

    for (let v = -R; v <= R && stalls.length < maxCars; v += pitch) {
      // 이 열에서 실제로 놓인 칸의 x 범위 — 차로 길이를 여기에 맞춘다
      let uMin = Infinity, uMax = -Infinity;

      for (const side of [0, 1]) {            // 차로 양쪽 두 줄
        const y0 = side === 0 ? v : v + STALL_L + AISLE_W;
        for (let u = -R; u <= R && stalls.length < maxCars; u += STALL_W) {
          const b = box(u, y0, STALL_W, STALL_L);
          if (!b.rc.every(([x, y]) => inFootM(x, y))) continue;
          stalls.push({ poly: b.poly });
          if (u < uMin) uMin = u;
          if (u + STALL_W > uMax) uMax = u + STALL_W;
        }
      }

      // 칸이 하나라도 놓였으면 그 앞에 차로를 그린다
      if (uMax > uMin) {
        const a2 = box(uMin, v + STALL_L, uMax - uMin, AISLE_W);
        if (a2.rc.some(([x, y]) => inFootM(x, y))) aisles.push({ poly: a2.poly });
      }
    }
    if (stalls.length > best.stalls.length) best = { stalls, aisles, angleDeg: a };
  }
  return best;
}

// ─── 소방차 진입·활동 공간 ────────────────────────────────────────
// 건축법 제49조, 「건축물의 피난·방화구조 등의 기준에 관한 규칙」 제11조
//   연면적 1천㎡ 이상 건축물은 소방자동차 접근이 가능한 통로를 설치해야 한다.
//   너비 4m 이상. 대로에 직접 접하지 않으면 부지 안으로 통로를 끌어와야 한다.
export const FIRE_LANE_W = 4;
export const FIRE_REQUIRED_AREA = 1000;

export type FireLane = {
  required: boolean;
  fromRoad: boolean;      // 접한 도로로 해결되는가
  laneArea: number;       // 부지 안으로 끌어올 때 먹는 면적 ㎡
  note: string;
};

/**
 * 접도 조건으로 소방차 진입 필요 여부를 본다.
 * roadWidthM 을 모르면 LH 연구 부록의 '도로접면'(광대한면/중로한면/소로한면/세로한면)으로 가늠한다.
 */
export function fireLane(totArea: number, roadFace: string, siteFrontM: number): FireLane {
  const required = totArea >= FIRE_REQUIRED_AREA;
  // 광대(25m↑)·중로(12~25m)는 도로에서 바로 소방활동이 된다고 본다
  const wide = /광대|중로/.test(roadFace || "");
  const laneArea = required && !wide ? +(FIRE_LANE_W * siteFrontM).toFixed(1) : 0;
  return {
    required, fromRoad: wide, laneArea,
    note: !required
      ? `연면적 ${Math.round(totArea)}㎡ — 1,000㎡ 미만이라 소방차 전용구역 의무 아님`
      : wide
        ? `${roadFace} — 도로에서 소방활동 가능`
        : `${roadFace || "협소 도로"} — 부지 안으로 너비 ${FIRE_LANE_W}m 통로 필요 (약 ${laneArea}㎡ 잠식)`,
  };
}

/**
 * 소방차 진입 통로를 대지에서 잘라낸다.
 * 통로 위로는 건물이 올라갈 수 없으므로, 건축가능영역을 구하기 전에 빼야 한다.
 * 도로에 접한 변(가장 가까운 도로 쪽)에서 폭 FIRE_LANE_W 띠를 대지 안쪽으로 확보한다.
 */
export function cutFireLane(
  site: GeoJSON.Position[][][], roadSide: "N" | "S" | "E" | "W"
): { rest: GeoJSON.Position[][][]; lane: GeoJSON.Position[][][] } {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  for (const p of site) for (const r of p) for (const c of r) {
    if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1];
  }
  const cy = (minY + maxY) / 2;
  const dLat = FIRE_LANE_W * M2LAT;
  const dLon = FIRE_LANE_W * m2lon(cy);

  // 도로 쪽 변에서 안쪽으로 4m 띠
  const strip: GeoJSON.Position[][] =
    roadSide === "S" ? [[[minX, minY], [maxX, minY], [maxX, minY + dLat], [minX, minY + dLat], [minX, minY]]]
    : roadSide === "N" ? [[[minX, maxY - dLat], [maxX, maxY - dLat], [maxX, maxY], [minX, maxY], [minX, maxY - dLat]]]
    : roadSide === "W" ? [[[minX, minY], [minX + dLon, minY], [minX + dLon, maxY], [minX, maxY], [minX, minY]]]
    : [[[maxX - dLon, minY], [maxX, minY], [maxX, maxY], [maxX - dLon, maxY], [maxX - dLon, minY]]];

  try {
    const asMulti = (p: GeoJSON.Position[][]) => [p.map((r) => r.map((c) => [c[0], c[1]] as [number, number]))];
    let rest: GeoJSON.Position[][][] = [];
    let lane: GeoJSON.Position[][][] = [];
    for (const poly of site) {
      const diff = polygonClipping.difference(asMulti(poly) as never, asMulti(strip) as never);
      const inter = polygonClipping.intersection(asMulti(poly) as never, asMulti(strip) as never);
      rest = rest.concat(diff.map((q) => q.map((r) => r.map((c) => [c[0], c[1]] as GeoJSON.Position))));
      lane = lane.concat(inter.map((q) => q.map((r) => r.map((c) => [c[0], c[1]] as GeoJSON.Position))));
    }
    return { rest: rest.length ? rest : site, lane };
  } catch {
    return { rest: site, lane: [] };
  }
}
