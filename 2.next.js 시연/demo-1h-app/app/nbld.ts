// 주변 건물 매싱 — VWorld GIS건물통합정보(LT_C_BLDGINFO) 발자국 + 층수를 그대로 extrusion.
//
// b3dm(3D Tiles)은 텍스처가 CRN 이라 못 읽고, 연속지적과 좌표계도 어긋나서 접었다.
// LT_C_BLDGINFO 는 지적과 같은 계열이라 필지선 위에 딱 맞고, grnd_flr(지상층수)이 들어 있어
// 층수 × 층고로 높이를 세우면 충분히 '주변 맥락' 이 된다. 조회도 한 번이면 끝.

import type { FeatureCollection, Feature, Polygon } from "geojson";

const FLOOR_H = 3.3;

type BldProps = {
  bld_nm?: string; grnd_flr?: string; ugrnd_flr?: string;
  height?: string; useapr_day?: string; archarea?: string;
};

/** 선택 지점 주변 building 폴리곤(+높이). box 반경(도) ≈ 220m */
export async function fetchNeighborBuildings(
  center: [number, number], signal?: AbortSignal
): Promise<FeatureCollection<Polygon>> {
  const [lon, lat] = center;
  const dLat = 220 / 111320;
  const dLon = 220 / (111320 * Math.cos((lat * Math.PI) / 180));
  const box = `BOX(${(lon - dLon).toFixed(6)},${(lat - dLat).toFixed(6)},${(lon + dLon).toFixed(6)},${(lat + dLat).toFixed(6)})`;

  const qs = new URLSearchParams({
    path: "req/data", service: "data", request: "GetFeature",
    data: "LT_C_BLDGINFO", geomFilter: box, crs: "EPSG:4326",
    size: "600", format: "json", geometry: "true",
  });

  const r = await fetch(`/api/vworld?${qs}`, { signal });
  if (!r.ok) throw new Error("건물 조회 실패");
  const j = await r.json();
  const src: Feature[] = j?.response?.result?.featureCollection?.features ?? [];

  const out: Feature<Polygon>[] = [];
  for (const f of src) {
    const p = (f.properties ?? {}) as BldProps;
    const flr = Math.max(1, parseInt(p.grnd_flr ?? "", 10) || 0);
    const h = Number(p.height) > 0 ? Number(p.height) : flr * FLOOR_H;
    const yr = /^\d{8}$/.test(p.useapr_day ?? "") ? Number(p.useapr_day!.slice(0, 4)) : null;

    // MultiPolygon → Polygon 여러 장으로 펴기
    const g = f.geometry;
    const rings: number[][][][] =
      g?.type === "MultiPolygon" ? (g.coordinates as number[][][][])
      : g?.type === "Polygon" ? [g.coordinates as number[][][]]
      : [];
    for (const coords of rings) {
      out.push({
        type: "Feature",
        properties: { h, flr, name: p.bld_nm || "", year: yr, area: Number(p.archarea) || null },
        geometry: { type: "Polygon", coordinates: coords },
      });
    }
  }
  return { type: "FeatureCollection", features: out };
}
