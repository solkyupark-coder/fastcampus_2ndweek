import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "대지 조회 스타터",
  description: "VWorld 지도 위에서 시작하는 대지 조회 실습",
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
