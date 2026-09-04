import { NextRequest } from "next/server";

// VWorld API 서버사이드 프록시. 클라이언트는 key를 모른다.
// 사용: /api/vworld?path=req/data&data=LP_PA_CBND_BUBUN&geomFilter=POINT(127 37)&...
//       /api/vworld?path=ned/data/getLandCharacteristics&pnu=...&stdrYear=2024
//       /api/vworld?path=req/wms&LAYERS=lp_pa_cbnd_bubun&BBOX=...   (이미지)

// 키는 (1) 화면에서 붙여넣은 값 ?k=  (2) .env.local  순으로 찾는다.
const ENV_KEY = process.env.VWORLD_KEY ?? "";
const usable = (k: string) => !!k && !k.startsWith("여기에");
const BASE = "https://api.vworld.kr";
const ALLOW = new Set([
  "req/data", "req/wms", "req/wfs", "req/search", "req/address",
  "ned/data/getLandCharacteristics", "ned/data/getLandUseAttr",
]);

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const KEY = (sp.get("k") ?? "").trim() || ENV_KEY;
  if (!usable(KEY))
    return Response.json({ error: "VWorld 인증키가 없습니다 — 왼쪽 패널에 키를 붙여넣으세요" }, { status: 401 });
  const path = sp.get("path") ?? "";
  if (!ALLOW.has(path)) return Response.json({ error: "허용되지 않은 path" }, { status: 400 });

  const out = new URLSearchParams();
  sp.forEach((v, k) => { if (k !== "path" && k !== "k") out.set(k, v); });
  out.set("key", KEY);
  out.set("domain", "http://localhost");
  if (path.startsWith("ned/")) out.set("format", out.get("format") ?? "json");

  const url = `${BASE}/${path}?${out.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  const ct = r.headers.get("content-type") ?? "application/octet-stream";
  const buf = await r.arrayBuffer();
  return new Response(buf, {
    status: r.status,
    headers: { "content-type": ct, "cache-control": ct.startsWith("image/") ? "public, max-age=86400" : "no-store" },
  });
}