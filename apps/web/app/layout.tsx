import type { Metadata } from "next";
import localFont from "next/font/local";

import DemoBanner from "@web/demo/demo-banner";
import { isDemoMode } from "@web/demo/write-guard";

import "./globals.css";

// Editorial pairing, served offline (#44): Iosevka for numerals/mono,
// Source Sans 3 (humanist) for body. OFL licenses live in ./fonts/.
const sans = localFont({
  display: "swap",
  src: [
    {
      path: "./fonts/source-sans-3-latin-400-normal.woff2",
      style: "normal",
      weight: "400",
    },
    {
      path: "./fonts/source-sans-3-latin-700-normal.woff2",
      style: "normal",
      weight: "700",
    },
  ],
  variable: "--font-sans",
});

const mono = localFont({
  display: "swap",
  src: [
    { path: "./fonts/iosevka-latin-400-normal.woff2", style: "normal", weight: "400" },
    { path: "./fonts/iosevka-latin-700-normal.woff2", style: "normal", weight: "700" },
  ],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "worthline",
  description: "Local-first net worth dashboard",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html className={`${sans.variable} ${mono.variable}`} lang="es">
      <body>
        {(await isDemoMode()) ? <DemoBanner /> : null}
        {children}
      </body>
    </html>
  );
}
