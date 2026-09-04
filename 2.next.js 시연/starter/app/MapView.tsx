"use client";

import { useEffect, useRef, useState } from "react";
import type * as MLGL from "maplibre-gl";

/* maplibre-gl 은 CDN(layout.tsx)에서 불러옵니다.
   npm 으로 번들하면 Next 의 워커 처리 문제로 GeoJSON 레이어가 렌더되지 않습니다. */
declare global {
  interface Window { maplibregl: typeof MLGL; __map?: MLGL.Map }
}

type Parcel = Record<string, string>;

export default function MapView() {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLGL.Map | null>(null);

  const [base, setBase] = useState<"Base" | "Satellite">("Base");
  const [showParcels, setShowParcels] = useState(true);
  const [count, setCount] = useState<number | null>(null);
  const [clicked, setClicked] = useState<{ lng: number; lat: number; addr: string } | null>(null);

  // STEP 5-8 상태
  const [parcelPoly, setParcelPoly] = useState<GeoJSON.FeatureCollection | null>(null);
  const [landInfo, setLandInfo] = useState<Record<string, string> | null>(null);
  const [buildingInfo, setBuildingInfo] = useState<any>(null);
  const [scaleInfo, setScaleInfo] = useState<ScaleResult | null>(null);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [massGeoJSON, setMassGeoJSON] = useState<GeoJSON.FeatureCollection | null>(null);


  /* ── VWorld 인증키 ───────────────────────────────────────────
     수업에서는 .env.local 대신 화면에서 직접 붙여넣습니다.
     입력한 키는 이 브라우저(localStorage)에만 남습니다.        */
  const loadingParcels = useRef(false);

  /* 스타일이 준비됐을 때만 필지를 올린다.
     준비 전에 addSource 를 부르면 예외가 나므로 빈 소스로 한 번 찔러본다.
     setStyle 이후에도 다시 불러야 해서 함수로 뺐다. */
  const ensureParcels = (map: MLGL.Map) => {
    // 지워진 지도(StrictMode 첫 인스턴스 등)를 만지면 예외가 난다
    if (loadingParcels.current || mapRef.current !== map) return;
    try {
      if (map.getSource("parcels")) return;
      map.addSource("__probe", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.removeSource("__probe");
    } catch { return; }
    loadingParcels.current = true;
    loadParcels(map).finally(() => { loadingParcels.current = false; });
  };

  /** 스타일이 준비될 때까지 짧게 재시도한다 (최대 20초) */
  const pumpParcels = (map: MLGL.Map) => {
    ensureParcels(map);
    const t = setInterval(() => {
      if (mapRef.current !== map) { clearInterval(t); return; }
      ensureParcels(map);
      if (map.getSource("parcels")) clearInterval(t);
    }, 250);
    setTimeout(() => clearInterval(t), 20000);
  };

  const [vkey, setVkey] = useState("");
  const [vkeyDraft, setVkeyDraft] = useState("");
  useEffect(() => {
    const saved = localStorage.getItem("vworld_key") ?? "";
    setVkey(saved); setVkeyDraft(saved);
  }, []);
  const applyKey = () => {
    const k = vkeyDraft.trim();
    localStorage.setItem("vworld_key", k);
    setVkey(k);
  };
  /** 지금 쓸 키 — state 가 아직 비었으면 저장값을 바로 읽는다 */
  const keyNow = () =>
    vkey || (typeof window !== "undefined" ? localStorage.getItem("vworld_key") ?? "" : "");
  const kq = () => (keyNow() ? "&k=" + encodeURIComponent(keyNow()) : "");

  /* ============================================================
     STEP 1 — 배경지도
     ------------------------------------------------------------
     VWorld 는 타일(정사각형 이미지 조각)을 z/y/x 로 내려줍니다.
     타일 주소에는 인증키가 들어갑니다. 브라우저가 직접 부르면
     개발자도구 Network 탭에 키가 그대로 보입니다.
     그래서 /api/vworld-tile 을 거칩니다. 키는 서버(.env.local)에만 있습니다.
     ============================================================ */
  const style = (layer: string): MLGL.StyleSpecification => {
    const layers = layer === "Satellite" ? ["Satellite", "Hybrid"] : [layer];
    const sources: Record<string, MLGL.SourceSpecification> = {};
    const styleLayers: MLGL.LayerSpecification[] = [];
    layers.forEach((L, i) => {
      sources["bg" + i] = {
        type: "raster",
        tiles: ["/api/vworld-tile?t=" + L + "&z={z}&y={y}&x={x}" + kq()],
        tileSize: 256,
        attribution: "© VWorld",
      };
      styleLayers.push({ id: "bg" + i, type: "raster", source: "bg" + i });
    });
    // glyphs = 지도 위 글자용 폰트. 이게 없으면 text-field 레이어가 통째로 실패한다.
    return {
      version: 8,
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources,
      layers: styleLayers,
    };
  };

  useEffect(() => {
    if (mapRef.current || !box.current) return;
    let dead = false;

    (async () => {
      for (let i = 0; i < 100 && !window.maplibregl; i++) await new Promise((r) => setTimeout(r, 50));
      if (dead || !box.current || !window.maplibregl) return;

      const map = new window.maplibregl.Map({
        container: box.current,
        style: style("Base"),
        center: [126.978, 37.5665],   // 서울시청
        zoom: 15,
      });
      mapRef.current = map;
      window.__map = map;
      map.addControl(new window.maplibregl.NavigationControl(), "top-right");
      map.addControl(new window.maplibregl.ScaleControl({ unit: "metric" }));

      /* 배경지도 타일이 401이면(키 없음) map 의 "load" 는 끝내 오지 않습니다.
         그래도 필지 838개는 떠야 하므로 styledata 로도 시작하고,
         스타일이 인라인 객체라 이미 파싱이 끝났을 수 있어 한 번은 즉시 시도합니다.
         started 플래그로 중복 실행만 막습니다. */
      /* 배경지도 타일이 401이면(키 없음) "load" 가 끝내 오지 않는다.
         그래도 필지 838개는 떠야 하므로 스타일 준비를 직접 확인하며 올린다. */
      map.on("styledata", () => ensureParcels(map));
      pumpParcels(map);

      /* ============================================================
         STEP 2 — 클릭한 지점의 좌표
         이 좌표가 다음 단계(주소·필지 조회)의 입력값이 됩니다.
         ============================================================ */
      map.on("click", async (e) => {
        const { lng, lat } = e.lngLat;
        setClicked({ lng, lat, addr: "조회 중…" });
        const addr = await getAddress(lng, lat);
        setClicked({ lng, lat, addr });
      });
    })();

    return () => { dead = true; mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  /* ============================================================
     STEP 3 — 좌표 → 지번 주소 (역지오코딩)
     ------------------------------------------------------------
     api.vworld.kr 을 브라우저에서 바로 fetch 하면 CORS 에 막힙니다.

       Access to fetch at 'https://api.vworld.kr/...' has been blocked by CORS policy

     내 페이지(localhost:3000)와 VWorld(api.vworld.kr)는 출처가 다릅니다.
     출처가 다른 응답을 자바스크립트가 읽으려면 그 서버가
     Access-Control-Allow-Origin 헤더로 허락해야 하는데, VWorld 는 안 보냅니다.

     ※ VWorld 에 localhost 를 등록한 것과는 다른 이야기입니다.
       도메인 등록은 "VWorld 가 응답을 줄지",
       CORS 는 "브라우저가 그 응답을 JS에게 읽게 할지" 입니다.
       그래서 지도 타일(img)은 되고 fetch 만 막힙니다.

     서버끼리는 CORS 가 없습니다. 브라우저의 규칙이기 때문입니다.
     그래서 우리 서버(/api/vworld)가 대신 부릅니다.
     ============================================================ */
  async function getAddress(lng: number, lat: number) {
    const qs = new URLSearchParams({
      path: "req/address", service: "address", request: "getAddress", version: "2.0",
      point: lng + "," + lat, crs: "epsg:4326", type: "PARCEL", format: "json",
    });
    try {
      const j = await fetch("/api/vworld?" + qs + kq()).then((r) => r.json());
      return j?.response?.result?.[0]?.text ?? "(이 지점에는 지번 주소가 없습니다)";
    } catch (e) {
      console.warn("주소 조회 실패", e);
      return "(조회 실패 — F12 콘솔을 보세요)";
    }
  }

  /* ============================================================
     STEP 4 — CSV 를 읽어 838필지를 지도에 찍기
     ------------------------------------------------------------
     public/data/필지목록.csv 는 LH 토지주택연구원
     『OSC기반 매입임대주택 정비모델 연구』(2025) 부록에서 뽑은
     서울시 노후 매입임대 838필지입니다. 좌표와 PNU 가 붙어 있습니다.

     흐름:  CSV 텍스트 → 배열 → GeoJSON → 지도 레이어
     ============================================================ */
  async function loadParcels(map: MLGL.Map) {
    const text = await fetch("/data/필지목록.csv").then((r) => r.text());
    const rows = parseCSV(text);

    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: rows
        .filter((p) => p["경도"] && p["위도"])
        .map((p) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [Number(p["경도"]), Number(p["위도"])] },
          properties: p,
        })),
    };

    map.addSource("parcels", { type: "geojson", data: fc });
    // STEP 5용 필지 폴리곤 소스 (초기 빈 상태)
    map.addSource("parcel-poly", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addSource("mass", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "parcels", type: "circle", source: "parcels",
      paint: {
        // OSC 공법 유형에 따라 색을 다르게
        "circle-color": ["match", ["get", "OSC공법"],
          "소형", "#2e7d32", "중형", "#f9a825", "대형", "#c62828", "#9e9e9e"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 14, 6, 17, 9],
        "circle-stroke-width": 1.2, "circle-stroke-color": "#fff",
      },
    });
    setCount(fc.features.length);

    map.on("click", "parcels", async (e) => {
      const p = e.features![0].properties as Parcel;
      const lng = e.lngLat.lng;
      const lat = e.lngLat.lat;
      const pnu = p["PNU"] || "";

      new window.maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          "<b>" + p["자치구"] + " " + p["법정동"] + " " + p["지번"] + "</b><br>" +
          "대지면적 " + (p["대지면적_m2"] || "–") + "㎡<br>" +
          "노후 " + (p["노후년수"] || "–") + "년 · 임대 " + (p["임대세대수"] || "–") + "세대<br>" +
          "OSC 공법 " + (p["OSC공법"] || "미배정")
        )
        .addTo(map);

      // STEP 5-8 순차 실행
      setLoading({ 필지경계: true, 토지특성: true, 건축물대장: true, 규모검토: true });

      // STEP 5: 필지 폴리곤
      const parcelFc = await getParcel(lng, lat, keyNow());
      if (parcelFc) {
        setParcelPoly(parcelFc);
        if (map.getSource("parcel-poly")) {
          (map.getSource("parcel-poly") as MLGL.GeoJSONSource).setData(parcelFc);
        } else {
          map.addSource("parcel-poly", { type: "geojson", data: parcelFc });
          map.addLayer({
            id: "parcel-poly-fill", type: "fill", source: "parcel-poly",
            paint: { "fill-color": "#1f3a93", "fill-opacity": 0.15 },
          });
          map.addLayer({
            id: "parcel-poly-line", type: "line", source: "parcel-poly",
            paint: { "line-color": "#1f3a93", "line-width": 2.5 },
          });
        }
      }
      setLoading(l => ({ ...l, 필지경계: false }));

      // STEP 6: 토지특성 (PNU로 조회)
      if (pnu) {
        const land = await getLand(pnu, keyNow());
        if (land) {
          setLandInfo(land);
          const picked = pickLand(land);
          console.log("[STEP6 결과]", picked);

          // STEP 8: 규모검토 계산
          const area = Number(picked.area) || Number(p["대지면적_m2"]) || 0;
          if (area > 0 && picked.uz) {
            const scale = calcScale(area, picked.uz);
            if (scale) {
              setScaleInfo(scale);
              console.log("[STEP8 규모검토]", scale);
            }
          }
        }
        setLoading(l => ({ ...l, 토지특성: false }));
      } else {
        setLoading(l => ({ ...l, 토지특성: false }));
      }

      // STEP 7: 건축물대장/인허가
      if (pnu) {
        const bld = await getBuilding(pnu);
        setBuildingInfo(bld);
        setLoading(l => ({ ...l, 건축물대장: false }));

        // 3D 매스 생성 (법정 최대 + 현재 건물)
        if (parcelFc && scaleInfo) {
          const polys = polysOf(parcelFc.features[0]?.geometry);
          if (polys) {
            const mass = buildMassGeoJSON(polys, scaleInfo, {
              showCurrent: !!bld?.existing,
              currentBld: bld?.existing ? {
                platArea: bld.existing.platArea || 0,
                archArea: bld.existing.archArea || 0,
                grndFlr: bld.existing.grndFlr || 0,
                heit: bld.existing.heit || 0,
              } : undefined,
            });
            setMassGeoJSON(mass);
            if (map.getSource("mass")) {
              (map.getSource("mass") as MLGL.GeoJSONSource).setData(mass);
            } else {
              map.addSource("mass", { type: "geojson", data: mass });
              // fill-extrusion 레이어들 추가
              map.addLayer({
                id: "mass-3d", type: "fill-extrusion", source: "mass",
                filter: ["==", ["get", "kind"], "sel"],
                paint: {
                  "fill-extrusion-color": "#1d4ed8",
                  "fill-extrusion-height": ["get", "top"],
                  "fill-extrusion-base": ["get", "base"],
                  "fill-extrusion-opacity": 0.75,
                },
              });
              // 현재 건물 — 면(반투명 흰색)
              map.addLayer({
                id: "mass-cur-fill", type: "fill-extrusion", source: "mass",
                filter: ["==", ["get", "kind"], "cur-fill"],
                paint: {
                  "fill-extrusion-color": "#ffffff",
                  "fill-extrusion-height": ["get", "top"],
                  "fill-extrusion-base": ["get", "base"],
                  "fill-extrusion-opacity": 0.15,
                },
              });
              // 현재 건물 — 선(흰색 아웃라인)
              map.addLayer({
                id: "mass-cur-line", type: "line", source: "mass",
                filter: ["==", ["get", "kind"], "cur-line"],
                paint: {
                  "line-color": "#ffffff",
                  "line-width": 2,
                  "line-opacity": 0.9,
                },
              });
              map.addLayer({
                id: "mass-label", type: "symbol", source: "mass",
                filter: ["==", ["get", "tip"], true],
                layout: {
                  "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"],
                  "text-size": 11, "text-offset": [0, -0.4], "text-allow-overlap": true,
                },
                paint: { "text-color": "#1e3a8a", "text-halo-color": "#fff", "text-halo-width": 1.8 },
              });
            }
            if (map.getPitch() < 20) map.easeTo({ pitch: 50, duration: 700 });
          }
        }
      } else {
        setLoading(l => ({ ...l, 건축물대장: false }));
      }

      setLoading(l => ({ ...l, 규모검토: false }));
    });
    map.on("mouseenter", "parcels", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "parcels", () => { map.getCanvas().style.cursor = ""; });


    const xs = fc.features.map((f) => (f.geometry as GeoJSON.Point).coordinates[0]);
    const ys = fc.features.map((f) => (f.geometry as GeoJSON.Point).coordinates[1]);
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]],
      { padding: { top: 40, right: 40, bottom: 40, left: 300 }, duration: 0 });
  }

  // 배경지도 전환 — 스타일을 갈아끼우면 레이어가 지워지므로 다시 올립니다.
  useEffect(() => {
    const map = mapRef.current;
    // count 가 찰 때까지(=최초 필지 로드 완료) 기다린다.
    // 마운트 직후 setStyle 을 부르면 방금 올린 소스가 지워진다.
    if (!map || !count) return;
    map.setStyle(style(base));
    // setStyle 은 소스를 전부 지운다 → 준비되는 대로 다시 올린다
    pumpParcels(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  /* 인증키가 바뀌면 스타일을 통째로 갈지 않고 타일 주소만 바꾼다.
     setStyle 을 부르면 필지 838개가 잠깐 사라지기 때문이다. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      if (mapRef.current !== map) return true;   // 지워진 지도 → 중단
      if (!map.getStyle()) return false;
      const names = base === "Satellite" ? ["Satellite", "Hybrid"] : [base];
      let done = false;
      names.forEach((L, i) => {
        const src = map.getSource("bg" + i) as unknown as
          { setTiles?: (t: string[]) => void } | undefined;
        if (src?.setTiles) {
          src.setTiles(["/api/vworld-tile?t=" + L + "&z={z}&y={y}&x={x}" + kq()]);
          done = true;
        }
      });
      return done;
    };
    if (apply()) return;
    const t = setInterval(() => { if (apply()) clearInterval(t); }, 250);
    const stop = setTimeout(() => clearInterval(t), 10000);
    return () => { clearInterval(t); clearTimeout(stop); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vkey]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer("parcels")) {
      map.setLayoutProperty("parcels", "visibility", showParcels ? "visible" : "none");
    }
  }, [showParcels]);


  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={box} style={{ position: "absolute", inset: 0 }} />

      <div className="panel">
        <h1>대지 조회 스타터</h1>

        <div className="sec">
          <b>VWorld 인증키</b>
          <div className="keyrow">
            <input
              type="text" value={vkeyDraft} placeholder="키를 붙여넣으세요"
              onChange={(e) => setVkeyDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") applyKey(); }}
              spellCheck={false} autoComplete="off"
            />
            <button type="button" onClick={applyKey}>적용</button>
          </div>
          <div className="dim">
            {vkey
              ? "적용됨 · " + vkey.slice(0, 8) + "…"
              : "키가 없으면 배경지도와 조회가 동작하지 않습니다"}
          </div>
        </div>

        <div className="sec">
          <b>배경지도</b>
          <label><input type="radio" checked={base === "Base"} onChange={() => setBase("Base")} /> 일반</label>
          <label><input type="radio" checked={base === "Satellite"} onChange={() => setBase("Satellite")} /> 위성</label>
        </div>

        <div className="sec">
          <b>필지 목록 (CSV)</b>
          <label>
            <input type="checkbox" checked={showParcels} onChange={(e) => setShowParcels(e.target.checked)} /> 지도에 표시
          </label>
          <div className="dim">{count === null ? "불러오는 중…" : count + "필지"}</div>
        </div>

        <div className="sec">
          <b>클릭한 지점</b>
          <div className="out">
            {clicked ? (
              <>
                <span className="k">경도</span> {clicked.lng.toFixed(6)}<br />
                <span className="k">위도</span> {clicked.lat.toFixed(6)}<br />
                <span className="k">주소</span> {clicked.addr}
              </>
            ) : "지도를 클릭해 보세요."}
          </div>
        </div>

        {/* STEP 5: 필지 경계 */}
        {parcelPoly && (
          <div className="sec">
            <b>STEP 5 — 필지 경계 (VWorld 연속지적)</b>
            <div className="out">
              {parcelPoly.features.length}개 폴리곤 조회됨
              {loading.필지경계 && <span className="dim"> · 불러오는 중…</span>}
            </div>
          </div>
        )}

        {/* STEP 6: 토지특성 */}
        {landInfo && (
          <div className="sec">
            <b>STEP 6 — 토지특성 (토지이음/토지특성)</b>
            <div className="out">
              {(() => {
                const p = pickLand(landInfo);
                return (
                  <>
                    <span className="k">용도지역</span> {p.uz || "–"}<br />
                    <span className="k">지목</span> {p.jimok || "–"}<br />
                    <span className="k">면적</span> {p.area ? Number(p.area).toLocaleString() + "㎡" : "–"}<br />
                    <span className="k">공시지가</span> {p.price ? Number(p.price).toLocaleString() + "원/㎡" : "–"}<br />
                    <span className="k">형상</span> {p.shape || "–"}<br />
                    <span className="k">도로접면</span> {p.road || "–"}
                    {loading.토지특성 && <span className="dim"> · 불러오는 중…</span>}
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {/* STEP 7: 건축물대장/인허가 */}
        {buildingInfo !== null && (
          <div className="sec">
            <b>STEP 7 — 건축물대장·인허가 (건축HUB)</b>
            <div className="out">
              {buildingInfo?.existing ? (
                <>
                  <span className="k">현황 건물</span> 있음<br />
                  <span className="k">구조</span> {buildingInfo.existing.strct || "–"}<br />
                  <span className="k">층수</span> 지상 {buildingInfo.existing.grndFlr || "–"}층 / 지하 {buildingInfo.existing.ugrndFlr || "–"}층<br />
                  <span className="k">연면적</span> {buildingInfo.existing.totArea ? buildingInfo.existing.totArea.toLocaleString() + "㎡" : "–"}<br />
                  <span className="k">용도</span> {buildingInfo.existing.purps || "–"}<br />
                  <span className="k">사용승인</span> {buildingInfo.existing.useAprDay || "–"}
                </>
              ) : (
                <>건축물대장 등재 내역 없음 (나대지)</>
              )}
              {buildingInfo?.permit && (
                <>
                  <br /><span className="k">인허가</span> {buildingInfo.permit.status || "–"}<br />
                  <span className="k">허가일</span> {buildingInfo.permit.pmsDay || "–"}<br />
                  <span className="k">착공일</span> {buildingInfo.permit.stcnsDay || "–"}<br />
                  <span className="k">사용승인</span> {buildingInfo.permit.useAprDay || "–"}
                </>
              )}
              {loading.건축물대장 && <span className="dim"> · 불러오는 중…</span>}
            </div>
          </div>
        )}

        {/* STEP 8: 규모검토 */}
        {scaleInfo && (
          <div className="sec">
            <b>STEP 8 — 규모검토 (법정 최대)</b>
            <div className="out">
              <span className="k">용도지역</span> {scaleInfo.legal}<br />
              <span className="k">대지면적</span> {scaleInfo.siteArea.toLocaleString()}㎡<br />
              <span className="k">법정 건폐율</span> {scaleInfo.bcr}% → 최대 건축면적 {scaleInfo.maxBuildingArea.toLocaleString()}㎡<br />
              <span className="k">법정 용적률</span> {scaleInfo.far}% → 최대 연면적 {scaleInfo.maxTotalArea.toLocaleString()}㎡<br />
              <span className="k">가능 층수</span> 지상 {scaleInfo.maxFloors}층<br />
              <span className="k">예상 세대수</span> {Math.floor((scaleInfo.maxTotalArea * 0.8) / 21)}세대 (전용 21㎡ 기준)<br />
              {loading.규모검토 && <span className="dim"> · 계산 중…</span>}
            </div>
          </div>
        )}

        {/* 3D 매스 토글 */}
        {massGeoJSON && (
          <div className="sec">
            <b>3D 매스 (피치 50° 이상에서 확인)</b>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <input type="checkbox" defaultChecked onChange={(e) => {
                const map = mapRef.current;
                const vis = e.target.checked ? "visible" : "none";
                if (map?.getLayer("mass-3d")) map.setLayoutProperty("mass-3d", "visibility", vis);
                if (map?.getLayer("mass-cur-fill")) map.setLayoutProperty("mass-cur-fill", "visibility", vis);
                if (map?.getLayer("mass-cur-line")) map.setLayoutProperty("mass-cur-line", "visibility", vis);
                if (map?.getLayer("mass-label")) map.setLayoutProperty("mass-label", "visibility", vis);
              }} /> 법정 최대/현재 건물 매스 표시
            </label>
          </div>
        )}

        <div className="sec dim" style={{ fontSize: 11, color: "#9ca3af" }}>
          <b>진행:</b> 필지 클릭 → 주소(STEP3) → 필지경계(STEP5) → 토지특성(STEP6) → 건축물대장(STEP7) → 규모검토(STEP8) → 3D매스
        </div>

      </div>
    </div>
  );
}

/** 아주 단순한 CSV 파서 — 따옴표로 감싼 칸과 쉼표를 처리합니다 */
function parseCSV(text: string): Parcel[] {
  const NL = "\n";
  const CR = "\r";
  const Q = '"';
  const BOM = "﻿";

  const rows: string[][] = [];
  let row: string[] = [], cell = "", inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === Q && text[i + 1] === Q) { cell += Q; i++; }   // "" 는 따옴표 한 개
      else if (c === Q) inQuote = false;
      else cell += c;
    } else if (c === Q) inQuote = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === NL) { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== CR) cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }

  // 첫 줄이 제목 줄입니다. 엑셀 호환용 BOM 이 붙어 있으면 떼어냅니다.
  const head = rows.shift()!.map((h) => (h[0] === BOM ? h.slice(1) : h).trim());
  return rows
    .filter((r) => r.length === head.length)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/* ============================================================
   여기서부터 채워 나갑니다
   ------------------------------------------------------------
   STEP 5  필지 경계 그리기   VWorld 데이터 API (LP_PA_CBND_BUBUN)
   STEP 6  용도지역·지목·면적  토지이음(토지특성)
   STEP 7  건물 정보          건축HUB 건축물대장
   STEP 8  규모검토           대지면적 × 법정 건폐율/용적률
   ============================================================ */

// VWorld API 호출 헬퍼 (CORS 우회용 우리 서버 프록시)
const vworld = (path: string, params: Record<string, string>, k = "") =>
  `/api/vworld?path=${encodeURIComponent(path)}&${new URLSearchParams(params).toString()}`
  + (k ? "&k=" + encodeURIComponent(k) : "");

// 법정 건폐율/용적률 테이블 (용도지역명 부분 일치로 매핑)
const LEGAL: Record<string, [number, number]> = {
  제1종전용주거: [50, 100], 제2종전용주거: [40, 120],
  제1종일반주거: [60, 150], 제2종일반주거: [60, 200], 제3종일반주거: [50, 250],
  준주거: [60, 400], 중심상업: [60, 1000], 일반상업: [60, 800], 근린상업: [60, 600], 준공업: [60, 400],
};
function legalOf(uz: string) {
  for (const k in LEGAL) if (uz && uz.includes(k)) return LEGAL[k];
  return null;
}

// STEP 5 — 클릭한 지점의 필지 폴리곤 가져오기 (VWorld 연속지적 GetFeature)
export async function getParcel(lng: number, lat: number, key = "") {
  const qs = new URLSearchParams({
    path: "req/data", service: "data", request: "GetFeature",
    data: "LP_PA_CBND_BUBUN", geomFilter: `POINT(${lng} ${lat})`,
    geometry: "true", crs: "EPSG:4326", size: "1", format: "json",
  });
  const j = await fetch(vworld("req/data", Object.fromEntries(qs), key)).then((r) => r.json());
  const fc = j?.response?.result?.featureCollection;
  console.log("[STEP5] 필지 폴리곤:", fc);
  return fc as GeoJSON.FeatureCollection | null;
}

// STEP 6 — PNU 로 토지특성(용도지역·지목·면적·공시지가) 조회 (토지이음/토지특성)
export async function getLand(pnu: string, key = "") {
  if (!pnu) return null;
  const yr = new Date().getFullYear();
  for (const y of [yr, yr - 1, yr - 2]) {
    try {
      const r = await fetch(vworld("ned/data/getLandCharacteristics", {
        pnu, stdrYear: String(y), numOfRows: "1", pageNo: "1", format: "json",
      }, key)).then((x) => x.json());
      const f = r?.landCharacteristicss?.field?.[0] ?? r?.response?.fields?.field?.[0];
      if (f) {
        console.log("[STEP6] 토지특성:", f);
        return f as Record<string, string>;
      }
    } catch (e) { console.warn("토지특성 조회 실패", e); }
  }
  return null;
}

// 토지특성 응답에서 필요한 필드만 추출
export function pickLand(land: Record<string, string>) {
  const g = (...ks: string[]) => { for (const k of ks) if (land[k]) return land[k]; return ""; };
  return {
    uz: g("prposArea1Nm", "prposArea2Nm", "lclasUcdNm"),     // 용도지역
    jimok: g("lndcgrCodeNm"),                                 // 지목
    area: g("ladArea", "lndpclAr"),                           // 면적
    price: g("pblntfPclnd"),                                  // 공시지가
    shape: g("ladShape", "tpgrphFrmNm"),                      // 형상
    road: g("roadSideCodeNm"),                                // 도로접면
  };
}

// STEP 7 — 건축물대장 + 건축인허가 조회 (건축HUB, data.go.kr)
export async function getBuilding(pnu: string) {
  if (!/^\d{19}$/.test(pnu)) return null;
  try {
    const j = await fetch(`/api/building?pnu=${pnu}`).then((r) => r.json());
    console.log("[STEP7] 건축물대장/인허가:", j);
    return j; // { existing: {...}, permit: {...} }
  } catch (e) {
    console.warn("건축물 조회 실패", e);
    return null;
  }
}

export function calcScale(siteArea: number, uz: string): ScaleResult | null {
  const legal = legalOf(uz);
  if (!legal || !(siteArea > 0)) return null;
  const [bcr, far] = legal;
  const maxBuildingArea = Math.floor(siteArea * bcr / 100);
  const maxTotalArea = Math.floor(siteArea * far / 100);
  const maxFloors = Math.max(1, Math.floor(maxTotalArea / maxBuildingArea));
  return { siteArea, bcr, far, maxBuildingArea, maxTotalArea, maxFloors, legal: uz };
}

// 3D 매스용 폴리곤 오프셋 (건폐율만큼 대지 안쪽으로 축소)
function offsetPolygon(coords: GeoJSON.Position[][], distance: number): GeoJSON.Position[][] {
  // 단순 구현: turf.buffer 음수 버전 대체용 (실제로는 @turf/turf 권장)
  // 여기서는 중심점 기준 스케일링으로 근사
  const all = coords.flat();
  const cx = all.reduce((s, p) => s + p[0], 0) / all.length;
  const cy = all.reduce((s, p) => s + p[1], 0) / all.length;
  const factor = Math.max(0, 1 - distance / 100); // 매우 근사치
  return coords.map(ring => ring.map(([x, y]) => [
    cx + (x - cx) * factor,
    cy + (y - cy) * factor
  ]));
}

// 가장 큰 폴리곤 선택 (메인 필지)
function getMainPolygon(polys: GeoJSON.Position[][][]): GeoJSON.Position[][] {
  if (polys.length <= 1) return polys;
  return polys.reduce((max, p) => {
    const area = Math.abs(p[0].reduce((sum, pt, i, arr) => {
      const next = arr[(i + 1) % arr.length];
      return sum + pt[0] * next[1] - pt[1] * next[0];
    }, 0) / 2);
    const maxArea = Math.abs(max[0].reduce((sum, pt, i, arr) => {
      const next = arr[(i + 1) % arr.length];
      return sum + pt[0] * next[1] - pt[1] * next[0];
    }, 0) / 2);
    return area > maxArea ? p : max;
  });
}

// 선택한 필지 폴리곤으로 법정 최대 매스 GeoJSON 생성
export function buildMassGeoJSON(
  polys: GeoJSON.Position[][][],
  scale: ScaleResult,
  opts: { showCurrent?: boolean; currentBld?: { platArea: number; archArea: number; grndFlr: number; heit: number } } = {}
): GeoJSON.FeatureCollection {
  const FLOOR_H = 3.0;
  const feats: GeoJSON.Feature[] = [];
  const footprints = offsetPolygon(polys, 3); // 3m 이격 근사

  // 법정 최대 매스 (층별 슬래브)
  for (let i = 0; i < scale.maxFloors; i++) {
    const baseH = i * FLOOR_H;
    const topH = (i + 1) * FLOOR_H - 0.25;
    for (const poly of footprints) {
      feats.push({
        type: "Feature",
        properties: { kind: "sel", base: baseH, top: topH, floor: i + 1 },
        geometry: { type: "Polygon", coordinates: poly },
      });
    }
  }
  // 라벨 (최상층 중심)
  if (footprints.length) {
    const c = footprints[0].reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map(v => v / footprints[0].length) as [number, number];
    feats.push({
      type: "Feature",
      properties: { kind: "sel", base: 0, top: 0, tip: true, label: `${scale.maxFloors}층 · ${Math.round(scale.maxTotalArea).toLocaleString()}㎡ · 용적 ${scale.far}%` },
      geometry: { type: "Point", coordinates: c },
    });
  }

  // 현재 건물 (대장 값이 있으면) — 메인 필지에만 그림
  if (opts.showCurrent && opts.currentBld) {
    const { platArea, archArea, grndFlr, heit } = opts.currentBld;
    if (platArea && archArea && grndFlr) {
      const mainPoly = getMainPolygon(polys);
      const shrink = Math.sqrt(archArea / platArea);
      const perFloorH = heit ? heit / grndFlr : FLOOR_H;
      const shrunk = offsetPolygon(mainPoly, 3).map(ring => ring.map(([x, y]) => {
        const cx = mainPoly[0].reduce((s, p) => s + p[0], 0) / mainPoly[0].length;
        const cy = mainPoly[0].reduce((s, p) => s + p[1], 0) / mainPoly[0].length;
        return [cx + (x - cx) * shrink, cy + (y - cy) * shrink];
      }));
      for (let i = 0; i < grndFlr; i++) {
        const baseH = i * perFloorH;
        const topH = (i + 1) * perFloorH - 0.2;
        // 면(반투명 흰색) + 선(흰색 아웃라인) 두 가지로 표현
        feats.push({
          type: "Feature",
          properties: { kind: "cur-fill", base: baseH, top: topH },
          geometry: { type: "Polygon", coordinates: shrunk },
        });
        feats.push({
          type: "Feature",
          properties: { kind: "cur-line", base: baseH, top: topH },
          geometry: { type: "Polygon", coordinates: shrunk },
        });
      }
    }
  }

  return { type: "FeatureCollection", features: feats };
}
