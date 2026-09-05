import { NextRequest } from "next/server";

// VWorld WMTS 배경타일 프록시 (key가 경로에 필요하므로 별도 라우트)
const ENV_KEY = process.env.VWORLD_KEY ?? "";
const usable = (k: string) => !!k && !k.startsWith("여기에");
const TYPES = new Set(["Base", "Satellite", "Hybrid", "gray", "midnight"]);

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const KEY = (sp.get("k") ?? "").trim() || ENV_KEY;
  if (!usable(KEY)) return new Response("VWorld 인증키 없음", { status: 401 });
  const t = sp.get("t") ?? "Base";
  const z = sp.get("z"), y = sp.get("y"), x = sp.get("x");
  if (!TYPES.has(t) || !z || !y || !x) return new Response("bad params", { status: 400 });
  const ext = t === "Satellite" ? "jpeg" : "png";
  const url = `https://api.vworld.kr/req/wmts/1.0.0/${KEY}/${t}/${z}/${y}/${x}.${ext}`;
  const r = await fetch(url, { cache: "no-store" });
  const buf = await r.arrayBuffer();
  return new Response(buf, {
    status: r.status,
    headers: {
      "content-type": r.headers.get("content-type") ?? `image/${ext}`,
      "cache-control": "public, max-age=604800",
    },
  });
}