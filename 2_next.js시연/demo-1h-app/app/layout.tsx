import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "LH OSC 매입임대 노후필지",
  description: "LH 『OSC기반 매입임대주택 정비모델 연구』(2025) 부록 필지 + VWorld·토지이음 조회",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko">
      <head>
        <link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet" />
      </head>
      <body>
        <Script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js" strategy="beforeInteractive" />
        {children}
      </body>
    </html>
  );
}
