// 필지 카드 내용을 실무 산출물로 내보낸다.
//  · CSV  — 엑셀에서 바로 열리는 항목/값/출처 3열
//  · 인쇄 — A4 한 장 요약(브라우저 인쇄 → PDF)

import type { Scale } from "./scale";

export type Row = [string, string, string]; // 항목, 값, 출처

export type ExportInput = {
  addr: string;
  pnu: string;
  id: string;
  land: { uz: string; jimok: string; area: string; price: string; road: string; shape: string };
  lh?: Record<string, string>;
  scale?: Scale | null;
  bld?: {
    existing?: { strct: string; grndFlr: number | null; ugrndFlr: number | null; heit: number | null;
      totArea: number | null; bcRat: number | null; vlRat: number | null; fmly: number | null;
      useAprDay: string; pkngIn: number | null; pkngOut: number | null } | null;
    permit?: { status: string; sameAsExisting: boolean; gb: string; strct: string;
      totArea: number | null; bcRat: number | null; vlRat: number | null; fmly: number | null;
      pmsDay: string; stcnsDay: string; useAprDay: string; pkng: number | null } | null;
  } | null;
  trades?: { scope: string; dong: string; months: number; n: number; median: number; p25: number; p75: number } | null;
  stores?: { radius: number; total: number; lcls: [string, number][] } | null;
  walks?: { name: string; kind: string; meters: number; seconds: number }[] | null;
};

const won = (v: number) => `${v.toLocaleString()}원/㎡`;
const m2 = (v: number | null | undefined) => (v == null ? "–" : `${v.toLocaleString()}㎡`);

export function buildRows(x: ExportInput): Row[] {
  const r: Row[] = [];
  r.push(["소재지", x.addr, ""]);
  if (x.pnu) r.push(["PNU", x.pnu, "VWorld 연속지적"]);
  if (x.id && x.id !== "—") r.push(["매입임대 고유번호", x.id, "LH 연구 부록"]);

  r.push(["용도지역", x.land.uz || "–", "토지이음"]);
  r.push(["지목", x.land.jimok || "–", "토지이음"]);
  r.push(["대지면적", x.land.area ? `${(+x.land.area).toLocaleString()}㎡` : "–", "토지이음"]);
  r.push(["도로접면", x.land.road || x.lh?.["도로접면"] || "–", x.land.road ? "토지이음" : "LH 연구 부록"]);
  r.push(["지형형상", x.land.shape || x.lh?.["지형형상"] || "–", x.land.shape ? "토지이음" : "LH 연구 부록"]);
  if (x.land.price) r.push(["개별공시지가", won(+x.land.price), "토지이음"]);
  if (x.lh?.["공시지가_2026"]) r.push(["개별공시지가(2026)", won(+x.lh["공시지가_2026"]), "공시지가 CSV"]);

  const e = x.bld?.existing;
  if (e) {
    r.push(["[기존 건물] 구조", e.strct || "–", "건축물대장"]);
    r.push(["[기존 건물] 층수", `지상 ${e.grndFlr ?? "–"}${e.ugrndFlr ? ` / 지하 ${e.ugrndFlr}` : ""}${e.heit ? ` · ${e.heit}m` : ""}`, "건축물대장"]);
    r.push(["[기존 건물] 연면적", m2(e.totArea), "건축물대장"]);
    r.push(["[기존 건물] 건폐율/용적률", `${e.bcRat ?? "–"}% / ${e.vlRat ?? "–"}%`, "건축물대장"]);
    r.push(["[기존 건물] 가구수", e.fmly ? `${e.fmly}가구` : "–", "건축물대장"]);
    r.push(["[기존 건물] 주차", `${(e.pkngIn ?? 0) + (e.pkngOut ?? 0)}대`, "건축물대장"]);
    r.push(["[기존 건물] 사용승인", e.useAprDay || "–", "건축물대장"]);
  }
  const p = x.bld?.permit;
  if (p && !p.sameAsExisting) {
    r.push(["[인허가] 상태", `${p.gb} · ${p.status === "허가만" ? "허가만 · 미착공" : p.status}`, "건축인허가"]);
    r.push(["[인허가] 구조/연면적", `${p.strct || "–"} · ${m2(p.totArea)}`, "건축인허가"]);
    r.push(["[인허가] 건폐율/용적률", `${p.bcRat ?? "–"}% / ${p.vlRat ?? "–"}%`, "건축인허가"]);
    r.push(["[인허가] 가구/주차", `${p.fmly ?? "–"}가구 · ${p.pkng ?? 0}대`, "건축인허가"]);
    r.push(["[인허가] 허가/착공/사용승인", `${p.pmsDay || "–"} / ${p.stcnsDay || "–"} / ${p.useAprDay || "–"}`, "건축인허가"]);
  } else if (p?.sameAsExisting) {
    r.push(["[인허가]", `대장과 일치 (허가 ${p.pmsDay} → 준공 ${p.useAprDay}) · 계획된 신축 없음`, "건축인허가"]);
  }

  const s = x.scale;
  if (s) {
    r.push(["[규모검토] 법정 상한", `건폐 ${s.zone.bcr}% / 용적 ${s.zone.far}%`, "서울시 도시계획 조례"]);
    r.push(["[규모검토] 최대 건축면적", m2(s.maxArch), "산정"]);
    r.push(["[규모검토] 최대 연면적", m2(s.maxTot), "산정"]);
    if (s.spare) r.push(["[규모검토] 여유 연면적", m2(s.spare.tot), "산정"]);
    for (const c of s.cases) r.push([`[규모검토] ${c.label}`, `${c.units}세대 · 법정주차 ${c.parking}대`, c.rule]);
    r.push(["[규모검토] 다가구 부설주차", `${s.parkingDagagu}대`, "주차장법 시행령 별표1"]);
  }

  const t = x.trades;
  if (t) {
    r.push(["[시세] 토지 실거래 중앙값", won(t.median), `국토부 · ${t.scope === "dong" ? t.dong : "자치구"} · ${t.months}개월 ${t.n}건`]);
    r.push(["[시세] 25~75분위", `${won(t.p25)} ~ ${won(t.p75)}`, "국토부"]);
  }

  if (x.walks?.length) {
    for (const w of x.walks) {
      r.push([`[접근] ${w.kind === "subway" ? "지하철" : "버스"}`,
        `${w.name} · 보행 ${w.meters.toLocaleString()}m / ${Math.max(1, Math.round(w.seconds / 60))}분`, "OSM · Valhalla"]);
    }
  }
  const st = x.stores;
  if (st) {
    r.push([`[상권] 반경 ${st.radius}m 업소`, `${st.total.toLocaleString()}개`, "소상공인시장진흥공단"]);
    r.push(["[상권] 업종 구성", st.lcls.slice(0, 5).map(([k, v]) => `${k} ${v}`).join(" · "), "소상공인시장진흥공단"]);
  }
  if (x.lh?.["버스정류장"] !== undefined) {
    r.push(["[도보권 800m] LH 조사",
      `지하철 ${x.lh["지하철역"]} · 버스 ${x.lh["버스정류장"]} · 초등 ${x.lh["초등학교"]} · 중고 ${x.lh["중고등학교"]}`,
      "LH 연구 부록"]);
  }
  return r;
}

export function downloadCSV(x: ExportInput) {
  const rows = buildRows(x);
  const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = "﻿" + [["항목", "값", "출처"], ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `대지조사서_${x.addr.replace(/[\\/:*?"<>|\s]/g, "_")}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function printSheet(x: ExportInput) {
  const rows = buildRows(x);
  const esc = (v: string) => v.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
  const body = rows.map(([k, v, src]) =>
    `<tr><th>${esc(k)}</th><td>${esc(v)}</td><td class="s">${esc(src)}</td></tr>`).join("");
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>대지조사서 ${esc(x.addr)}</title><style>
@page { size: A4; margin: 14mm; }
body { font: 11px/1.6 -apple-system,"Malgun Gothic",sans-serif; color:#111; }
h1 { font-size: 17px; margin: 0 0 2px; }
.sub { color:#666; font-size:10px; margin-bottom:10px; }
table { border-collapse: collapse; width: 100%; }
th,td { border-bottom: 1px solid #e5e5e5; padding: 4px 6px; text-align: left; vertical-align: top; }
th { width: 150px; font-weight: 600; color:#333; background:#fafafa; }
td.s { width: 130px; color:#999; font-size: 9.5px; }
.note { margin-top: 10px; font-size: 9.5px; color:#666; line-height:1.6; }
</style></head><body>
<h1>대지 조사서 — ${esc(x.addr)}</h1>
<div class="sub">${x.pnu ? `PNU ${esc(x.pnu)} · ` : ""}작성 ${new Date().toLocaleDateString("ko-KR")}</div>
<table>${body}</table>
<div class="note">
· 규모검토는 조회값 기반 개략 산정입니다. 대지안의 공지·건축선 후퇴·가로구역 최고높이·지구단위계획은 반영하지 않았습니다.<br>
· 토지 실거래는 국토부가 지번을 마스킹하여 제공하므로 법정동 단위 시세 비교입니다.<br>
· 인허가 판단이 아니며, 건축사의 검토·확인이 필요합니다.
</div>
<script>window.onload=()=>{window.print()}</script>
</body></html>`;
  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) { alert("팝업이 차단되었습니다. 팝업을 허용해 주세요."); return; }
  w.document.write(html);
  w.document.close();
}
