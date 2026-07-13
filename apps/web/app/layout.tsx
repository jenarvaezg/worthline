import ServiceWorkerRegister from "@web/_components/sw-register";
import ImpersonationBanner from "@web/admin/impersonation-banner";
import AssistantMount from "@web/asistente/assistant-mount";
import DemoBanner from "@web/demo/demo-banner";
import { isDemoMode, isImpersonating } from "@web/demo/write-guard";
import FormSubmitScrollKeeper from "@web/form-submit-scroll-keeper";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Suspense } from "react";

import "./globals.css";

import { SITE_URL } from "./site-url";

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

// Bitter is the restrained display voice of the bound ledger: globally
// available, but product CSS limits it to h1/h2 (cover surfaces may opt in).
const display = localFont({
  display: "swap",
  src: [
    { path: "./fonts/bitter-latin-600-normal.woff2", style: "normal", weight: "600" },
    { path: "./fonts/bitter-latin-700-normal.woff2", style: "normal", weight: "700" },
    { path: "./fonts/bitter-latin-600-italic.woff2", style: "italic", weight: "600" },
  ],
  variable: "--font-bitter",
});

export const viewport: Viewport = {
  themeColor: "#006f5f", // matches --green design token
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "worthline — El libro mayor de tu patrimonio",
    template: "%s · worthline",
  },
  description:
    "Todo tu patrimonio —activos, deudas, retornos reales, FIRE— en una sola imagen cerrada, auditable y tuya.",
  applicationName: "worthline",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "worthline",
  },
  icons: {
    apple: "/icon.svg",
  },
  openGraph: {
    type: "website",
    siteName: "worthline",
    locale: "es_ES",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html className={`${sans.variable} ${mono.variable} ${display.variable}`} lang="es">
      <body>
        {(await isDemoMode()) ? <DemoBanner /> : null}
        {(await isImpersonating()) ? <ImpersonationBanner /> : null}
        <ServiceWorkerRegister />
        <Suspense fallback={null}>
          <FormSubmitScrollKeeper />
        </Suspense>
        {/* Root-layout mount: el panel sobrevive a la navegación (#628/#629) */}
        <Suspense fallback={null}>
          <AssistantMount />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
