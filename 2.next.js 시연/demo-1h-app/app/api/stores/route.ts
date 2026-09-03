import { NextRequest } from "next/server";

// 소상공인시장진흥공단 상가(상권)정보 — 필지 반경 내 업소를 업종별로 집계.
const KEY = process.env.DATA_GO_KR_KEY ?? "";
const EP = "https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInRadius";

type Store = {
  bizesNm: string; indsLclsNm: string; indsMclsNm: string; indsSclsNm: string;
  lon: number | string; lat: number | string;
};

const cache = new Map<string, { at: number; data: unknown }>();
const TTL = 1000 * 60 * 60 * 12;

export async function GET(req: NextRequest) {
  if (!KEY) return Response.json({ error: "DATA_GO_KR_KEY 미설정" }, { status: 500 });
  const sp = req.nextUrl.searchParams;
  const cx = sp.get("cx"), cy = sp.get("cy");
  const radius = Math.min(2000, Math.max(50, parseInt(sp.get("radius") ?? "500", 10)));
  if (!cx || !cy) return Response.json({ error: "cx, cy 필요" }, { status: 400 });

  const ck = `${(+cx).toFixed(5)},${(+cy).toFixed(5)},${radius}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL) return Response.json(hit.data);

  // 한 페이지 1000건 상한. 최대 2페이지(2000건)까지만 집계.
  const pages = [1, 2];
  const all: Store[] = [];
  let total = 0;
  for (const pageNo of pages) {
    const url = `${EP}?serviceKey=${KEY}&radius=${radius}&cx=${cx}&cy=${cy}` +
      `&numOfRows=1000&pageNo=${pageNo}&type=json`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) break;
    const j = await r.json();
    total = Number(j?.body?.totalCount ?? total);
    const items: Store[] = j?.body?.items ?? [];
    all.push(...items);
    if (items.length < 1000) break;
  }

  const cnt = (key: keyof Store) => {
    const m = new Map<string, number>();
    for (const s of all) {
      const v = (s[key] as string) || "기타";
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const data = {
    radius,
    total,                       // 반경 내 전체 업소 수 (API 집계)
    sampled: all.length,         // 실제 집계에 쓴 건수
    lcls: cnt("indsLclsNm").slice(0, 8),
    mcls: cnt("indsMclsNm").slice(0, 10),
    points: all.slice(0, 1200).map((s) => ({
      n: s.bizesNm, l: s.indsLclsNm,
      x: Number(s.lon), y: Number(s.lat),
    })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
  };
  cache.set(ck, { at: Date.now(), data });
  return Response.json(data);
}
