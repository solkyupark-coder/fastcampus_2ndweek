// VWorld 3D 건물(3D Tiles / b3dm) 을 MapLibre 위에 얹는다.
//
// xdworld.vworld.kr 은 공개 타일 서버라 인증키가 필요 없고, CORS 도 열려 있다.
// deck.gl 의 Tile3DLayer 가 tileset.json 순회 → b3dm 파싱 → glTF 렌더까지 처리한다.
//
// 참고: unitbuild_site_all.py 는 같은 타일셋을 파이썬에서 직접 파싱해
//       b3dm 헤더를 뜯고 GLB 를 꺼내 Rhino/Revit 으로 넘긴다. 여기서는 웹에서 그대로 그린다.

import { MapboxOverlay } from "@deck.gl/mapbox";
import { Tile3DLayer } from "@deck.gl/geo-layers";
import { Tiles3DLoader } from "@loaders.gl/3d-tiles";
import type * as MLGL from "maplibre-gl";

export const VWORLD_3D_TILESET =
  "https://xdworld.vworld.kr/TDServer/services/facility_LOD4/vworld_3d_facility.json";

type Deck = { setProps: (p: Record<string, unknown>) => void; finalize?: () => void };

let overlay: (MLGL.IControl & Deck) | null = null;

/** 지도에 3D 건물 오버레이를 올린다(이미 있으면 재사용). */
export function ensureOverlay(map: MLGL.Map) {
  if (overlay) return overlay;
  overlay = new MapboxOverlay({
    interleaved: false,   // MapLibre 레이어와 섞지 않고 위에 얹는다
    layers: [],
  }) as unknown as MLGL.IControl & Deck;
  map.addControl(overlay);
  return overlay;
}

/**
 * 3D 건물 표시.
 *  · show=false 면 레이어를 비운다
 *  · opacity 로 반투명하게 해서 법정 최대 매스와 같이 볼 수 있게 한다
 */
export function setBuildings3D(
  map: MLGL.Map,
  show: boolean,
  opts: { opacity?: number; onLoad?: (n: number) => void; center?: [number, number]; radius?: number } = {}
) {
  const ov = ensureOverlay(map);
  if (!show || !opts.center) { ov.setProps({ layers: [] }); return; }

  // 전국 타일셋을 브라우저가 통째로 순회하지 않는다.
  // 서버가 선택 지점 반경의 b3dm 만 뽑아 1단계로 평탄화한 tileset 을 만들어 준다.
  const [lng, lat] = opts.center;
  // loaders.gl 은 상대 경로를 base 없이 해석하지 못한다. 절대 URL 로 넘긴다.
  // 경로가 .json 으로 끝나야 한다. 3D Tiles 로더는 확장자로 tileset 인지 타일인지 가르는데,
  // 쿼리만 있는 URL 은 타일(b3dm)로 보고 파싱하다 "unknown type" 으로 죽는다.
  // dx/dy: 3D 모델 ↔ 연속지적 경험적 보정(m). localStorage 로 현장에서 미세조정 가능.
  let nudge = "";
  try {
    const dx = localStorage.getItem("vw3d_dx"), dy = localStorage.getItem("vw3d_dy");
    if (dx) nudge += `&dx=${dx}`;
    if (dy) nudge += `&dy=${dy}`;
  } catch { /* SSR·프라이빗 모드 */ }
  const url =
    `${window.location.origin}/api/vworld-3d/tileset.json` +
    `?lng=${lng}&lat=${lat}&r=${opts.radius ?? 150}&max=16${nudge}`;

  const loadOptions = {
    // 타일이 많으면 화면이 무거워진다. 화면 근처만 촘촘히 받는다.
    "3d-tiles": { throttleRequests: true, maximumMemoryUsage: 128 },
    // VWorld 3D 타일의 텍스처는 CRN(Crunch) 압축이라 브라우저가 디코드하지 못한다.
    //   InvalidStateError: The source image could not be decoded
    // 서버(dequantize.ts)가 텍스처를 걷어내고 순백 플랫으로 구워 보낸다.
    gltf: { loadImages: false, loadBuffers: true },
    image: { type: "data" as const },
  };

  let loaded = 0;

  // 선택 필지 위 실제 건물 — 흰색 반투명. 조명 음영으로 형태가 읽히게 한다.
  // (deck.gl 3D Tiles 는 깔끔한 모서리선을 싸게 못 그린다. 면 음영으로 대신한다.)
  const layer = new Tile3DLayer({
    id: `vworld-3d-${lng.toFixed(5)}-${lat.toFixed(5)}`,
    data: url,
    loader: Tiles3DLoader,
    loadOptions,
    opacity: opts.opacity ?? 0.6,
    getColor: [255, 255, 255],
    pickable: false,
    onTilesetLoad: (tileset: { tiles?: unknown[] }) => opts.onLoad?.(tileset?.tiles?.length ?? 0),
    onTileLoad: () => opts.onLoad?.(++loaded),
  });

  ov.setProps({ layers: [layer] });
}

export function disposeOverlay(map: MLGL.Map) {
  if (!overlay) return;
  try { map.removeControl(overlay); } catch { /* 이미 지워짐 */ }
  overlay = null;
}
