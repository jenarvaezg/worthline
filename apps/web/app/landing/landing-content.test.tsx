import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { heroSheetData } from "./hero-sheet/build-hero-sheet";
import LandingContent from "./landing-content";

/**
 * Landing pública (#951, PRD #877): las 9 secciones del content outline #860
 * con el copy aprobado (prototipo #862 tras crítica adversaria), en orden.
 * La sección 2 del outline (la prueba visual) vive absorbida en la hoja
 * encartada del hero — decisión registrada en la resolución de #862.
 */

const html = renderToStaticMarkup(<LandingContent />);

/** The approved headline of each section, in reading order. */
const SECTION_ANCHORS = [
  // 1 · Hero (cubierta)
  "Evoluciona tu Excel",
  // 2 · Prueba visual — la hoja encartada (absorbe la captura del outline)
  "Neto total",
  // 3 · De tu Excel a worthline
  "De tu hoja… a worthline",
  // 4 · Lo que tu Excel no podía
  "¿Está funcionando de verdad tu cartera?",
  // 5 · Actualizar sin dolor
  "Actualizar deja de ser un trabajo",
  // 6 · Control y trazabilidad
  "Tus cifras, cerradas y tuyas.",
  // 7 · IA contenida
  "Habla con tu patrimonio. Y que te responda con la cifra exacta.",
  // 8 · Avanzado: MCP
  "Tu patrimonio, leíble por tu agente.",
  // 9 · Cierre (contracubierta)
  "Tu Excel ya hizo su trabajo",
];

describe("landing content (#951)", () => {
  test("renders the 9 outline sections in order", () => {
    let cursor = -1;

    for (const anchor of SECTION_ANCHORS) {
      const at = html.indexOf(anchor);

      expect(at, `section anchor «${anchor}» missing`).toBeGreaterThan(-1);
      expect(at, `section anchor «${anchor}» out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test("hero carries the approved lede and the single-image nuance", () => {
    expect(html).toContain("en una sola imagen");
    expect(html).toContain("Cerrada, auditable y tuya.");
    expect(html).toContain("El libro mayor de tu patrimonio");
  });

  test("CTA choreography: buttons only in hero and close, demo links in between", () => {
    expect(html.match(/Empezar con mis datos/g)).toHaveLength(2);
    expect(html.match(/href="\/login\?returnTo=\/app"/g)).toHaveLength(2);
    // Cada prueba/captura lleva su enlace discreto a la demo.
    expect(html).toContain("Velo en la demo");
    expect(html.match(/href="\/demo"/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(html).toMatch(/class="[^"]*stage[^"]*" data-cover-stage="4"/);
  });

  test("masthead reserves a neutral session slot and keeps a no-JS Entrar fallback", () => {
    expect(html).toContain("<noscript>");
    expect(html).toContain('href="/login"');
    expect(html).toContain("Entrar");
    expect(html.match(/Ir a mi panel/g)).toHaveLength(1);
  });

  test("keeps the claims discipline of the outline", () => {
    // Shipped-only: el extracto es CSV/Excel, nunca «cualquier broker».
    expect(html).toContain("Tu extracto CSV/Excel");
    expect(html).not.toMatch(/cualquier broker|tiempo real|conecta todos tus bancos/i);
    // El asistente solo lee; el MCP insinúa futuro sin prometer roadmap (#862).
    expect(html).toContain("solo lee");
    expect(html).toContain("de momento");
    // Ni una palabra de adjuntos/ingesta (decidido, sin código).
    expect(html).not.toMatch(/adjunto|ingesta/i);
  });

  test("the SSG hero sheet renders real, reconciled demo figures (bruto − deuda = neto)", () => {
    // Ya no es maqueta (S4, #952): las cifras vienen de la persona demo,
    // resueltas en build y cuadradas por el motor.
    expect(heroSheetData.grossMinor - heroSheetData.debtsMinor).toBe(
      heroSheetData.netMinor,
    );
    // El neto real y la fila de deuda con la línea del debe llegan al HTML.
    expect(html).toContain(heroSheetData.netLabel);
    const debit = heroSheetData.rows.find((row) => row.debit);
    expect(debit).toBeDefined();
    expect(html).toContain(debit!.value);
    // La copia honesta reemplaza al viejo sello «Maqueta».
    expect(html).not.toContain("Maqueta — captura real de la demo");
    expect(html).toContain("Persona demo «Familia»");
  });

  test("is whole without JS: no script tags, no event handlers", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/ on[a-z]+=/);
    expect(html).toContain("En 2025 cobraste");
    expect(html).toContain('aria-hidden="true"');
  });
});
