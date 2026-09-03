import { NextRequest } from "next/server";

// 국토교통부 토지 매매 실거래가 — 최근 N개월을 서버에서 모아 집계.
// 지번은 국토부가 마스킹(3**)하므로 필지 단위가 아닌 '법정동 단위 시세 비교'로만 쓴다.

const KEY = process.env.DATA_GO_KR_KEY ?? "";
const BASE = "https://apis.data.go.kr/1613000/RTMSDataSvcLandTrade/getRTMSDataSvcLandTrade";

export type Trade = {
  ym: string;      // 2025-10
  dong: string;
  jibun: string;   // 마스킹됨
  jimok: string;
  landUse: string; // 용도지역
  area: number;    // ㎡
  amount: number;  // 원
  unit: number;    // 원/㎡
  kind: string;    // 직거래 / 중개거래
  share: string;   // 지분 여부
};

const cache = new Map<string, { at: number; items: Trade[] }>();
const TTL = 1000 * 60 * 60 * 6;

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : "";
};

async function fetchMonth(lawd: string, ym: string): Promise<Trade[]> {
  const key = `${lawd}:${ym}`;
  const c = cache.get(key);
  if (c && Date.now() - c.at < TTL) return c.items;

  const url = `${BASE}?serviceKey=${KEY}&LAWD_CD=${lawd}&DEAL_YMD=${ym}&numOfRows=500&pageNo=1`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return [];
  const xml = await r.text();

  const items: Trade[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const area = parseFloat(tag(it, "dealArea") || "0");
    const amount = parseInt((tag(it, "dealAmount") || "0").replace(/[^\d]/g, ""), 10) * 10000;
    if (!(area > 0) || !(amount > 0)) continue;
    items.push({
      ym: `${tag(it, "dealYear")}-${tag(it, "dealMonth").padStart(2, "0")}`,
      dong: tag(it, "umdNm"),
      jibun: tag(it, "jibun"),
      jimok: tag(it, "jimok"),
      landUse: tag(it, "landUse"),
      area, amount,
      unit: Math.round(amount / area),
      kind: tag(it, "dealingGbn"),
      share: tag(it, "shareDealingType"),
    });
  }
  cache.set(key, { at: Date.now(), items });
  return items;
}

const pct = (a: number[], q: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round(lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo));
};

/** 지분거래·초소형 필지를 걷어낸 '온전한 대지' 거래만 */
const clean = (t: Trade[]) =>
  t.filter((x) => x.jimok === "대" && !/지분/.test(x.share) && x.area >= 20);

export async function GET(req: NextRequest) {
  if (!KEY) return Response.json({ error: "DATA_GO_KR_KEY 미설정" }, { status: 500 });
  const sp = req.nextUrl.searchParams;
  const lawd = sp.get("lawd") ?? "";
  const dong = sp.get("dong") ?? "";
  const months = Math.min(24, Math.max(1, parseInt(sp.get("months") ?? "12", 10)));
  if (!/^\d{5}$/.test(lawd)) return Response.json({ error: "lawd(시군구 5자리) 필요" }, { status: 400 });

  const now = new Date();
  const yms: string[] = [];
  for (let i = 1; i <= months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    yms.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  const all = (await Promise.all(yms.map((ym) => fetchMonth(lawd, ym)))).flat();
  const dongAll = dong ? clean(all.filter((t) => t.dong === dong)) : [];
  const sggAll = clean(all);
  // 법정동 표본이 얇으면 자치구로 넓힌다
  const scope = dongAll.length >= 5 ? "dong" : "sgg";
  const use = scope === "dong" ? dongAll : sggAll;

  const units = use.map((t) => t.unit);
  return Response.json({
    scope, dong, lawd, months,
    n: use.length,
    nDong: dongAll.length,
    nSgg: sggAll.length,
    nRaw: all.length,
    median: pct(units, 0.5),
    p25: pct(units, 0.25),
    p75: pct(units, 0.75),
    min: units.length ? Math.min(...units) : 0,
    max: units.length ? Math.max(...units) : 0,
    recent: [...use].sort((a, b) => (a.ym < b.ym ? 1 : -1)).slice(0, 8),
  });
}
