import type { Metadata } from "next";

import LandingContent from "./landing/landing-content";
import { SITE_URL } from "./site-url";

/**
 * The public landing at `/` (PRD #877 S6, #954 — el estreno). This ascends the
 * landing from its provisional `/landing` home and RETIRES the S1 307 redirect
 * to `/app`: `/` no longer bounces logged-out visitors into the dashboard.
 *
 * Under Cache Components (#1229) the route is static by construction: it reads
 * no cookies or store. Root-layout session banners live in their own Suspense,
 * so they don't force this page dynamic. The static tripwire lives in
 * `./landing/landing-static.test.ts`.
 */

const TITLE = "worthline — Evoluciona tu Excel";
const DESCRIPTION =
  "Todo tu patrimonio —activos, deudas, retornos reales, FIRE— por fin en una sola imagen. Cerrada, auditable y tuya.";

export const metadata: Metadata = {
  // Absolute so the marketing title escapes the layout's `%s · worthline` template.
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "worthline",
    locale: "es_ES",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function LandingPage() {
  return <LandingContent />;
}
