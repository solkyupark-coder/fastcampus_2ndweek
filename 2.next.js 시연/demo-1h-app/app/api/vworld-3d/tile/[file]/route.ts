import { NextRequest } from "next/server";
import { fixB3dm } from "../../dequantize";

/**
 * b3dm 타일 프록시.
 *
 * 경로 끝이 반드시 .b3dm 이어야 한다. 3D Tiles 로더는 확장자로 콘텐츠 종류를 판별하는데,
 * 쿼리스트링(?u=...)만 쓰면 "unknown type" 으로 죽는다.
 * 그래서 원본 URL 을 base64url 로 감싸 파일명처럼 만든다.
 */
const ALLOW_HOST = "xdworld.vworld.kr";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/vworld-3d/tile/[file]">) {
  const { file } = await ctx.params;
  const b64 = file.replace(/\.b3dm$/i, "");
  let url: URL;
  try {
    const raw = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    url = new URL(raw);
  } catch {
    return new Response("bad tile id", { status: 400 });
  }
  if (url.hostname !== ALLOW_HOST) return new Response("host not allowed", { status: 400 });

  const r = await fetch(url.toString(), { cache: "no-store" });
  if (!r.ok) return new Response("upstream " + r.status, { status: r.status });

  // 그대로 흘려보내면 건물이 1m 짜리로 나온다. 역양자화해서 내려보낸다
  const fixed = fixB3dm(Buffer.from(await r.arrayBuffer()));

  return new Response(new Uint8Array(fixed), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=86400",
    },
  });
}
