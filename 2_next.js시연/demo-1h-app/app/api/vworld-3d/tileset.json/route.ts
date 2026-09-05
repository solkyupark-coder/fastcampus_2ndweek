import { NextRequest } from "next/server";

/**
 * VWorld 3D 건물 — 선택한 지점 주변 타일만 잘라 미니 tileset.json 을 만들어 준다.
 *
 * 원본 타일셋은 전국을 덮는 다단계 트리라 브라우저가 통째로 순회하면 무겁고,
 * deck.gl 이 계층을 내려가지 못하는 경우도 있다.
 * 그래서 서버가 미리 순회해서 반경 안의 b3dm 리프만 뽑아 1단계 tileset 으로 평탄화한다.
 *
 * 로직은 unitbuild_site_all.py 의 _td_collect 와 같다.
 *   · boundingVolume.region(라디안)으로 반경 필터
 *   · geometricError 0(최세 LOD) 우선
 *   · content.uri 가 .json 이면 그 안으로 더 들어간다
 */

const ROOT = "https://xdworld.vworld.kr/TDServer/services/facility_LOD4/vworld_3d_facility.json";

type BV = { region?: number[] };
type Node = {
  boundingVolume?: BV;
  geometricError?: number;
  content?: { uri?: string };
  children?: Node[];
};

/** 타일 region(라디안)과 대상 지점의 거리(m). 겹치면 0 */
function distTo(bv: BV | undefined, lon: number, lat: number): number {
  const reg = bv?.region;
  if (!reg || reg.length < 4) return 0;               // region 이 없으면 통과
  const [w, s, e, n] = reg.slice(0, 4).map((r) => (r * 180) / Math.PI);
  const clat = (s + n) / 2, clon = (w + e) / 2;
  const dy = (lat - clat) * 111320;
  const dx = (lon - clon) * 111320 * Math.cos((lat * Math.PI) / 180);
  const hy = ((n - s) / 2) * 111320;
  const hx = ((e - w) / 2) * 111320 * Math.cos((lat * Math.PI) / 180);
  const nx = Math.max(-hx, Math.min(dx, hx));
  const ny = Math.max(-hy, Math.min(dy, hy));
  return Math.hypot(dx - nx, dy - ny);
}

type Leaf = { uri: string; bv: BV; ge: number; dist: number };

const b64url = (s: string) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const lon = Number(sp.get("lng")), lat = Number(sp.get("lat"));
  const radius = Math.min(1000, Math.max(30, Number(sp.get("r") ?? 150)));
  const maxTiles = Math.min(40, Math.max(1, Number(sp.get("max") ?? 16)));
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return Response.json({ error: "lng, lat 필요" }, { status: 400 });
  }

  const leaves: Leaf[] = [];
  let jsonCount = 0;
  const MAX_JSON = 24;

  async function walkUrl(url: string) {
    if (jsonCount >= MAX_JSON) return;
    jsonCount++;
    let ts: { root?: Node };
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return;
      ts = await r.json();
    } catch { return; }

    const base = url.replace(/\/[^/]*$/, "/");
    const stack: Node[] = [ts.root ?? {}];

    while (stack.length) {
      const node = stack.pop()!;
      const d = distTo(node.boundingVolume, lon, lat);
      if (d > radius) continue;                       // 반경 밖

      if (node.children?.length) { stack.push(...node.children); continue; }

      const uri = node.content?.uri ?? "";
      if (!uri || uri.toLowerCase().includes("-bridge")) continue;
      const full = new URL(uri, base).toString();

      if (uri.toLowerCase().endsWith(".json") || uri.toLowerCase().includes("tileset")) {
        await walkUrl(full);
      } else if (uri.toLowerCase().endsWith(".b3dm")) {
        leaves.push({ uri: full, bv: node.boundingVolume ?? {}, ge: node.geometricError ?? 0, dist: d });
      }
    }
  }

  await walkUrl(ROOT);

  // 최세 LOD(geometricError 0) 우선, 가까운 순
  const finest = leaves.filter((t) => t.ge === 0).length ? leaves.filter((t) => t.ge === 0) : leaves;
  finest.sort((a, b) => a.dist - b.dist || a.ge - b.ge);
  const picked = finest.slice(0, maxTiles);

  // 반경을 덮는 region (라디안)
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  const rad = (d: number) => (d * Math.PI) / 180;
  const rootRegion = [
    rad(lon - dLon), rad(lat - dLat), rad(lon + dLon), rad(lat + dLat), -100, 400,
  ];

  // VWorld 모델은 타원체고(絶對高)로 앉아 있다. 우리 지도는 지형이 없어 지면이 z=0 이라
  // 그대로 얹으면 그 동네 지반고만큼 통째로 뜬다. 법정 최대매스는 0 에서 올라가므로 서로 안 맞는다.
  //
  // region[4] = 그 타일 건물들의 바닥 높이(≈지반고). 언덕이라 타일마다 다르다.
  // 선택 지점에서 가장 가까운 타일들 중 '가장 높은' 바닥고를 기준으로 끌어내린다.
  //   (평균/최소를 쓰면 경사지에서 대상지 건물이 몇 m 떠버린다. 바닥선은 높은 쪽에 맞춘다.)
  // + DROP_FUDGE: region 박스가 실제 건물 밑동보다 살짝 낮게 잡히는 걸 보정.
  const DROP_FUDGE = 4;
  const groundTiles = picked.slice(0, 5).map((t) => t.bv.region?.[4]).filter((h): h is number => h != null);
  const hMin = (groundTiles.length ? Math.max(...groundTiles) : 0) + DROP_FUDGE;

  // VWorld 는 3D 시설물 레이어와 연속지적을 서로 다른 기준으로 서비스한다.
  // 둘이 수 m 어긋나는 건 데이터 자체의 문제라 코드로 완전히 못 맞춘다.
  // dx(동+), dy(북+) 로 경험적 보정만 열어 둔다. 기본값은 관악 신림 일대 눈대중.
  const dx = Number(sp.get("dx") ?? -1);
  const dy = Number(sp.get("dy") ?? 3);

  // 3D Tiles 의 transform 은 ECEF 열우선 4×4. 로컬 ENU 축으로 평행이동한다.
  const φ = (lat * Math.PI) / 180, λ = (lon * Math.PI) / 180;
  const up   = [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
  const east = [-Math.sin(λ), Math.cos(λ), 0];
  const north = [-Math.sin(φ) * Math.cos(λ), -Math.sin(φ) * Math.sin(λ), Math.cos(φ)];
  const tx = -hMin * up[0] + dx * east[0] + dy * north[0];
  const ty = -hMin * up[1] + dx * east[1] + dy * north[1];
  const tz = -hMin * up[2] + dx * east[2] + dy * north[2];
  const transform = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    tx, ty, tz, 1,
  ];

  const tileset = {
    asset: { version: "1.0" },
    geometricError: 200,
    root: {
      boundingVolume: { region: rootRegion },
      geometricError: 100,
      refine: "ADD",
      transform,
      children: picked.map((t) => ({
        boundingVolume: t.bv.region ? { region: t.bv.region } : { region: rootRegion },
        geometricError: 0,
        // 로더가 확장자로 종류를 판별하므로 .b3dm 으로 끝나게 만든다
        content: { uri: `/api/vworld-3d/tile/${b64url(t.uri)}.b3dm` },
      })),
    },
    _meta: { scanned: jsonCount, leaves: leaves.length, picked: picked.length, radius, hMin },
  };

  return Response.json(tileset, {
    headers: { "cache-control": "public, max-age=3600" },
  });
}
