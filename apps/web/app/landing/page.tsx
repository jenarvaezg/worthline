import type { Metadata } from "next";
import localFont from "next/font/local";

import LandingContent from "./landing-content";

/**
 * La landing es un estático puro (invariante de PRD #877): `force-static`
 * prerenderiza la ruta en build, con lo que las lecturas de cookies del root
 * layout se resuelven vacías en build y NINGUNA visita lee cookies ni abre la
 * base de datos. El tripwire de CI vive en landing-static.test.ts.
 *
 * La ruta vive en /landing hasta el estreno: S6 (#954) la asciende a `/`
 * sustituyendo el redirect provisional de fase 1.
 */
export const dynamic = "force-static";

// La voz de la cubierta (#862): Bitter solo para cubierta y titulares, servida
// offline como el resto de fuentes (OFL en ./fonts/LICENSE-bitter).
const display = localFont({
  display: "swap",
  src: [
    { path: "../fonts/bitter-latin-600-normal.woff2", style: "normal", weight: "600" },
    { path: "../fonts/bitter-latin-700-normal.woff2", style: "normal", weight: "700" },
    { path: "../fonts/bitter-latin-600-italic.woff2", style: "italic", weight: "600" },
  ],
  variable: "--font-bitter",
});

// Metadatos mínimos de la superficie pública; el paquete SEO completo
// (canonical, OG, robots, sitemap) es del estreno (S6, #954).
export const metadata: Metadata = {
  title: "worthline — Evoluciona tu Excel",
  description:
    "Todo tu patrimonio — activos, deudas, retornos reales, FIRE — por fin en una sola imagen. Cerrada, auditable y tuya.",
  // La URL provisional /landing no debe indexarse: desaparece en el estreno
  // (S6), que trae el paquete SEO completo y retira este noindex al ascender a `/`.
  robots: { index: false },
};

export default function LandingPage() {
  return (
    <div className={display.variable}>
      <LandingContent />
    </div>
  );
}
