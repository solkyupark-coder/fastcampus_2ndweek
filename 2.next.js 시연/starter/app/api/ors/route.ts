import { NextRequest } from "next/server";

// openrouteservice 등시선/경로 프록시 (키를 서버에서만 보관)
// POST /api/ors/isochrone  { locations: [[lon,lat]], profile: "foot-walking", range: [300,600,900], range_type: "time" }
// POST /api/ors/route      { coordinates: [[lon,lat],...], profile: "foot-walking" }
// POST /api/ors/matrix     { locations: [[lon,lat],...], profile: "foot-walking", sources: [0], destinations: [1,2] }

const KEY = process.env.ORS_KEY ?? "";
const BASE = "https://api.openrouteservice.org/v2";

function checkKey() {
  if (!KEY) throw new Error("ORS_KEY 미설정");
}

export async function POST(req: NextRequest) {
  checkKey();
  const sp = req.nextUrl.searchParams;
  const action = sp.get("action") ?? "isochrone"; // isochrone | route | matrix
  const body = await req.json();

  let url = "";
  switch (action) {
    case "isochrone":
      url = `${BASE}/isochrones/${body.profile ?? "foot-walking"}`;
      break;
    case "route":
      url = `${BASE}/directions/${body.profile ?? "foot-walking"}`;
      break;
    case "matrix":
      url = `${BASE}/matrix/${body.profile ?? "foot-walking"}`;
      break;
    default:
      return Response.json({ error: "알 수 없는 action" }, { status: 400 });
  }

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": KEY,
      "Content-Type": "application/json",
      "Accept": "application/json, application/geo+json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const ct = r.headers.get("content-type") ?? "application/json";
  const buf = await r.arrayBuffer();
  return new Response(buf, { status: r.status, headers: { "content-type": ct } });
}