import { NextRequest } from "next/server";

// 국토교통부 건축HUB — 건축물대장(기존 건물) + 건축인허가(신축/증축 계획)
// PNU 19자리를 그대로 파라미터로 쓴다: sgg(5) bjd(5) platGb(1) bun(4) ji(4)

const KEY = process.env.DATA_GO_KR_KEY ?? "";
const BLD = "https://apis.data.go.kr/1613000/BldRgstHubService";
const PMS = "https://apis.data.go.kr/1613000/ArchPmsHubService";

type Row = Record<string, string | number | null>;

const cache = new Map<string, { at: number; data: unknown }>();
const TTL = 1000 * 60 * 60 * 24;

async function call(base: string, op: string, q: string): Promise<Row[]> {
  try {
    const r = await fetch(`${base}/${op}?${q}`, { cache: "no-store" });
    if (!r.ok) return [];
    const j = await r.json();
    const items = j?.response?.body?.items;
    if (!items) return [];
    const it = items.item;
    if (!it) return [];
    return Array.isArray(it) ? it : [it];
  } catch {
    return [];
  }
}

const s = (v: unknown) => (v == null ? "" : String(v).trim());
const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const ymd = (v: unknown) => {
  const t = s(v);
  return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}` : "";
};

export async function GET(req: NextRequest) {
  if (!KEY) return Response.json({ error: "DATA_GO_KR_KEY 미설정" }, { status: 500 });
  const pnu = req.nextUrl.searchParams.get("pnu") ?? "";
  if (!/^\d{19}$/.test(pnu)) return Response.json({ error: "pnu 19자리 필요" }, { status: 400 });

  const hit = cache.get(pnu);
  if (hit && Date.now() - hit.at < TTL) return Response.json(hit.data);

  const q =
    `serviceKey=${KEY}&sigunguCd=${pnu.slice(0, 5)}&bjdongCd=${pnu.slice(5, 10)}` +
    `&platGbCd=0&bun=${pnu.slice(11, 15)}&ji=${pnu.slice(15, 19)}` +
    `&numOfRows=30&pageNo=1&_type=json`;

  const [title, bFlr, pmsB, pmsD, pmsF] = await Promise.all([
    call(BLD, "getBrTitleInfo", q),
    call(BLD, "getBrFlrOulnInfo", q),
    call(PMS, "getApBasisOulnInfo", q),
    call(PMS, "getApDongOulnInfo", q),
    call(PMS, "getApFlrOulnInfo", q),
  ]);

  // 기존 건물(대장) — 연면적이 가장 큰 동을 대표로
  const t = [...title].sort((a, b) => (n(b.totArea) ?? 0) - (n(a.totArea) ?? 0))[0];
  const existing = t
    ? {
        name: s(t.bldNm), purps: s(t.mainPurpsCdNm), etcPurps: s(t.etcPurps),
        strct: s(t.strctCdNm), roof: s(t.roofCdNm),
        platArea: n(t.platArea), archArea: n(t.archArea), totArea: n(t.totArea),
        bcRat: n(t.bcRat), vlRat: n(t.vlRat),
        grndFlr: n(t.grndFlrCnt), ugrndFlr: n(t.ugrndFlrCnt), heit: n(t.heit),
        fmly: n(t.fmlyCnt), hhld: n(t.hhldCnt), ho: n(t.hoCnt),
        pmsDay: ymd(t.pmsDay), useAprDay: ymd(t.useAprDay),
        pkngIn: n(t.indrAutoUtcnt), pkngOut: n(t.oudrAutoUtcnt),
        elvt: n(t.rideUseElvtCnt),
        flrs: bFlr
          .filter((f) => s(f.flrGbCdNm))
          .map((f) => ({
            gb: s(f.flrGbCdNm), no: n(f.flrNo),
            purps: s(f.etcPurps) || s(f.mainPurpsCdNm), area: n(f.area),
          }))
          .sort((a, b) => (a.gb === b.gb ? (a.no ?? 0) - (b.no ?? 0) : a.gb < b.gb ? 1 : -1)),
      }
    : null;

  // 인허가(계획) — 가장 최근 건
  const p = [...pmsB].sort((a, b) => s(b.crtnDay).localeCompare(s(a.crtnDay)))[0];
  const dong = p ? pmsD.find((d) => s(d.mgmPmsrgstPk) === s(p.mgmPmsrgstPk)) ?? pmsD[0] : null;
  // 진행 상태: archGbCdNm(신축/증축…)은 '공사 종류'일 뿐이라 날짜로 판정한다.
  //  사용승인 있음 → 준공(대장에 반영된 현재 건물) / 착공만 → 공사중 / 둘 다 없음 → 허가만(미착공)
  const pUseApr = ymd(p?.useAprDay);
  const pStcns = ymd(p?.realStcnsDay);
  const status = !p ? "" : pUseApr ? "준공" : pStcns ? "공사중" : "허가만";
  // 인허가의 사용승인일이 대장과 같으면 '지금 서 있는 건물'의 이력이지 새 계획이 아니다
  const sameAsExisting = !!(pUseApr && existing?.useAprDay && pUseApr === existing.useAprDay);

  const permit = p
    ? {
        status, sameAsExisting,
        name: s(p.bldNm), gb: s(p.archGbCdNm), purps: s(p.mainPurpsCdNm),
        platArea: n(p.platArea), archArea: n(p.archArea), totArea: n(p.totArea),
        bcRat: n(p.bcRat), vlRat: n(p.vlRat),
        fmly: n(p.fmlyCnt), hhld: n(p.hhldCnt), ho: n(p.hoCnt),
        pkng: n(p.totPkngCnt),
        jiyuk: s(p.jiyukCdNm), jiguk: s(p.jiguCdNm), guyuk: s(p.guyukCdNm),
        pmsDay: ymd(p.archPmsDay),      // 건축허가일
        stcnsDay: pStcns,               // 실착공일
        useAprDay: pUseApr,             // 사용승인일 (없으면 미준공)
        crtnDay: ymd(p.crtnDay),        // 데이터 갱신일 — 허가일이 아님
        strct: s(dong?.strctCdNm), roof: s(dong?.roofCdNm),
        flrs: pmsF
          .filter((f) => s(f.flrGbCdNm))
          .map((f) => ({
            gb: s(f.flrGbCdNm), no: n(f.flrNo),
            purps: s(f.mainPurpsCdNm), area: n(f.flrArea),
          }))
          .sort((a, b) => (a.gb === b.gb ? (a.no ?? 0) - (b.no ?? 0) : a.gb < b.gb ? 1 : -1)),
      }
    : null;

  const data = { pnu, existing, permit, nTitle: title.length, nPermit: pmsB.length };
  cache.set(pnu, { at: Date.now(), data });
  return Response.json(data);
}