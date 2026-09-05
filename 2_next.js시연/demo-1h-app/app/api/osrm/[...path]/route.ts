import { NextRequest } from "next/server";

/**
 * OSRM 라우팅 프록시.
 *
 * openstreetmap.org 가 쓰는 공개 OSRM(routing.openstreetmap.de)은 브라우저에서 직접 부르면
 * 부하가 걸릴 때 CORS 실패("Failed to fetch")로 툭툭 끊긴다. 서버를 거치면 CORS 가 없고,
 * 미러 한 곳을 예비로 두고 한 번 재시도할 수 있어 수업 중에 덜 죽는다.
 *
 *   브라우저  →  /api/osrm/routed-foot/route/v1/foot/<coords>?...   →  OSRM
 */

const MIRRORS = [
  "https://routing.openstreetmap.de",
  "https://router.project-osrm.org", // car 프로파일만. foot/bike 는 경로가 달라 사실상 route 폴백용
];

export async function GET(req: NextRequest, ctx: RouteContext<"/api/osrm/[...path]">) {
  const { path } = await ctx.params;
  const sub = (Array.isArray(path) ? path.join("/") : path) ?? "";
  const qs = req.nextUrl.search;

  // routed-foot/route/v1/foot/... 형태만 통과
  if (!/^routed-(foot|bike|car)\/(route|table)\/v1\/(foot|bike|driving)\//.test(sub)) {
    return Response.json({ code: "Invalid", message: "허용되지 않은 경로" }, { status: 400 });
  }

  const attempt = async (base: string): Promise<Response | null> => {
    try {
      const r = await fetch(`${base}/${sub}${qs}`, {
        headers: { "user-agent": "osc-workshop-demo/1.0" },
        signal: AbortSignal.timeout(7000),
        cache: "no-store",
      });
      if (r.ok) return r;
    } catch { /* 폴백 */ }
    return null;
  };

  let up = await attempt(MIRRORS[0]);
  // project-osrm 은 car 만 있으니 프로파일이 driving 일 때만 미러 시도
  if (!up && /\/driving\//.test(sub)) up = await attempt(MIRRORS[1]);

  if (!up) {
    return Response.json({ code: "Unavailable", message: "OSRM 응답 없음" }, { status: 503 });
  }
  const body = await up.text();
  return new Response(body, {
    status: up.status,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=600" },
  });
}
