import { ImageResponse } from "next/og";

import { heroSheetData } from "./landing/hero-sheet/build-hero-sheet";

/**
 * Open Graph / Twitter card for the estreno (PRD #877 S6, #954; owner asked to
 * "estudiar atributos opengraph"). A file-based metadata image at the app root,
 * so every share card carries the book-cover register — dark-green board, cream
 * ink, gold accent — instead of a bare title. The net figure is the SAME real
 * demo-persona close baked into the hero sheet (only demo data in images, per
 * the review checklist), resolved once at build via {@link heroSheetData}.
 */
export const alt = "worthline — Evoluciona tu Excel. El libro mayor de tu patrimonio.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Cover-register tokens, mirrored from globals.css (Satori cannot read CSS
// vars). The decorative accent is the gilt filete (`--gilt`), NOT `--gold` —
// gold is the "aviso/debe" warning ink per design-system.md §Color, so it must
// not stand in as a cover ornament.
const COVER = "#102420"; // --cover
const CREAM = "#ecefe1"; // --cover-ink
const GILT = "#c2a14e"; // --gilt (filete)
const MUTED = "#9fb0a3"; // --cover-muted

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: COVER,
        color: CREAM,
        padding: "72px 80px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: 32, fontWeight: 700, letterSpacing: 1 }}>worthline</span>
        <span style={{ fontSize: 22, letterSpacing: 4, color: MUTED }}>
          LIBRO MAYOR · MMXXVI
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontSize: 30, letterSpacing: 1, color: GILT, marginBottom: 20 }}>
          El libro mayor de tu patrimonio
        </span>
        <span style={{ fontSize: 100, fontWeight: 700, lineHeight: 1.02 }}>
          Evoluciona tu Excel.
        </span>
        <span style={{ fontSize: 34, color: MUTED, marginTop: 26, maxWidth: 920 }}>
          Todo tu patrimonio en una sola imagen: cerrada, auditable y tuya.
        </span>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          borderTop: `1px solid ${MUTED}`,
          paddingTop: 28,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 22, color: MUTED, marginBottom: 6 }}>
            Persona demo · cierre {heroSheetData.closeMonthLabel}
          </span>
          <span style={{ fontSize: 60, fontWeight: 700 }}>{heroSheetData.netLabel}</span>
        </div>
        <span style={{ fontSize: 24, color: MUTED }}>worthline-web.vercel.app</span>
      </div>
    </div>,
    { ...size },
  );
}
