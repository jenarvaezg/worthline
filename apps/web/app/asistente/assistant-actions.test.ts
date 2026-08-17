/**
 * Typed quick-action + source-destination tests (#631, ADR 0053/0052). The
 * model PROPOSES actions; the app renders only what validates against the typed
 * set, and only internal destinations — the model never supplies a raw URL.
 */

import {
  extractEmbeddedQuickActions,
  parseCorrectionProposal,
  parseQuickActions,
  resolveModelQuickActions,
  sourceHref,
} from "@web/asistente/assistant-actions";
import { describe, expect, it } from "vitest";

describe("parseQuickActions", () => {
  it("keeps the two typed actions and drops everything else", () => {
    const parsed = parseQuickActions([
      {
        type: "openInternalSource",
        label: "Ver hipoteca",
        href: "/patrimonio/h1/editar",
      },
      {
        type: "runSuggestedAnalysis",
        label: "¿Y mi liquidez?",
        prompt: "¿Cuál es mi liquidez?",
      },
      { type: "deleteHolding", label: "Borrar", href: "/patrimonio/h1/editar" }, // outside the set
      { type: "openInternalSource", label: "Externo", href: "https://evil.test" }, // not internal
      { type: "openInternalSource", label: "Protocolo", href: "//evil.test" }, // protocol-relative
      { type: "runSuggestedAnalysis", label: "", prompt: "" }, // empty
    ]);

    expect(parsed).toEqual([
      {
        type: "openInternalSource",
        label: "Ver hipoteca",
        href: "/patrimonio/h1/editar",
      },
      {
        type: "runSuggestedAnalysis",
        label: "¿Y mi liquidez?",
        prompt: "¿Cuál es mi liquidez?",
      },
    ]);
  });

  it("returns nothing for non-array or junk input", () => {
    expect(parseQuickActions(null)).toEqual([]);
    expect(parseQuickActions("nope")).toEqual([]);
    expect(parseQuickActions([{}, 3, "x"])).toEqual([]);
  });

  it("rejects hrefs that are not internal paths (open-redirect / scheme injection)", () => {
    for (const href of ["javascript:alert(1)", "http://x", "//x", "\\\\x", "x/y", ""]) {
      expect(
        parseQuickActions([{ type: "openInternalSource", label: "x", href }]),
      ).toEqual([]);
    }
  });

  it("rejects a path the URL parser folds into another origin (#1407)", () => {
    // The parser DELETES tab, LF and CR before resolving, so each of these reads as a
    // single-slash path and lands on `//evil.test/x`. Checked on the raw string, they
    // all passed — the chip would have been a link off-origin.
    for (const href of ["/\t/evil.test/x", "/\n/evil.test/x", "/\r/evil.test/x"]) {
      expect(
        parseQuickActions([{ type: "openInternalSource", label: "x", href }]),
      ).toEqual([]);
      expect(
        resolveModelQuickActions([{ type: "openInternalSource", label: "x", href }]),
      ).toEqual([]);
    }
  });

  it("carries the cleaned path, not the string it validated from", () => {
    expect(
      parseQuickActions([
        { type: "openInternalSource", label: "x", href: "/patri\tmonio" },
      ]),
    ).toEqual([{ type: "openInternalSource", label: "x", href: "/patrimonio" }]);
  });
});

describe("resolveModelQuickActions", () => {
  it("resolves holding and section refs into internal hrefs", () => {
    expect(
      resolveModelQuickActions([
        {
          type: "openInternalSource",
          label: "Ver Flores 11",
          holding: "wl_hld_abc",
        },
        {
          type: "openInternalSource",
          label: "Ver patrimonio",
          section: "patrimonio",
        },
      ]),
    ).toEqual([
      {
        type: "openInternalSource",
        label: "Ver Flores 11",
        href: "/patrimonio/wl_hld_abc/editar",
      },
      {
        type: "openInternalSource",
        label: "Ver patrimonio",
        href: "/patrimonio",
      },
    ]);
  });

  it("never emits a chip without a href, whatever the figure names (#1407)", () => {
    // Every object inherits these, so a plain map lookup answered «yes» for a figure
    // nobody registered and the resolved href came out `undefined` — not `null`, so it
    // walked past the guard and became `<Link href={undefined}>`, which throws while
    // rendering the panel.
    for (const figure of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(
        resolveModelQuickActions([{ type: "openInternalSource", label: "x", figure }]),
      ).toEqual([]);
    }
  });
});

describe("extractEmbeddedQuickActions", () => {
  it("strips a trailing actions JSON block and recovers chips", () => {
    const text =
      "Tu patrimonio está concentrado.\n\n" +
      JSON.stringify(
        {
          actions: [
            {
              type: "openInternalSource",
              label: "Ver detalle de Flores 11",
              holding: "wl_hld_6e8207be9e01d55c58e8245c5f694229",
            },
            {
              type: "runSuggestedAnalysis",
              label: "¿Cuál es mi capacidad de ahorro mensual?",
              prompt: "¿Cuál es mi capacidad de ahorro mensual?",
            },
          ],
        },
        null,
        2,
      );

    const { cleaned, actions } = extractEmbeddedQuickActions(text);

    expect(cleaned).toBe("Tu patrimonio está concentrado.");
    expect(actions).toEqual([
      {
        type: "openInternalSource",
        label: "Ver detalle de Flores 11",
        href: "/patrimonio/wl_hld_6e8207be9e01d55c58e8245c5f694229/editar",
      },
      {
        type: "runSuggestedAnalysis",
        label: "¿Cuál es mi capacidad de ahorro mensual?",
        prompt: "¿Cuál es mi capacidad de ahorro mensual?",
      },
    ]);
  });

  it("leaves ordinary text untouched when there is no actions block", () => {
    expect(extractEmbeddedQuickActions("Sin acciones aquí.")).toEqual({
      cleaned: "Sin acciones aquí.",
      actions: [],
    });
  });
});

describe("parseCorrectionProposal (#1051/#1053)", () => {
  const base = {
    draft: { proposalId: "prop-1" },
    folio: "1 propuesta · 1 holding · 1 lote atómico",
    guarantee: { state: "reconciled" },
    holding: { id: "wl_hld_x", name: "Hipoteca" },
    proposalType: "correction",
    summary: "Corrección",
  };

  it("accepts the anchor-only depth", () => {
    expect(
      parseCorrectionProposal({ ...base, edits: [], mode: "solo-desde-hoy" }),
    ).not.toBeNull();
  });

  it("accepts the reconstruct depth with a series, curve and anchor", () => {
    expect(
      parseCorrectionProposal({
        ...base,
        anchorMinor: 140_000_00,
        curve: [{ balanceMinor: 140_000_00, date: "2026-07-12" }],
        mode: "reconstruir",
        series: [{ balanceMinor: 140_000_00, date: "2026-07-12", origin: "assistant" }],
      }),
    ).not.toBeNull();
  });

  it("rejects a reconstruct payload missing the anchor", () => {
    expect(
      parseCorrectionProposal({
        ...base,
        curve: [],
        mode: "reconstruir",
        series: [],
      }),
    ).toBeNull();
  });

  it("rejects an unknown mode", () => {
    expect(parseCorrectionProposal({ ...base, mode: "otra-cosa" })).toBeNull();
  });
});

describe("sourceHref", () => {
  it("maps a holding to its worthline detail surface by its PUBLIC id (#1318)", () => {
    expect(sourceHref({ kind: "holding", publicId: "wl_hld_abc" })).toBe(
      "/patrimonio/wl_hld_abc/editar",
    );
  });

  it("maps product sections to their routes", () => {
    expect(sourceHref({ kind: "section", section: "patrimonio" })).toBe("/patrimonio");
    expect(sourceHref({ kind: "section", section: "historico" })).toBe("/historico");
    expect(sourceHref({ kind: "section", section: "objetivos" })).toBe("/objetivos");
    expect(sourceHref({ kind: "section", section: "resumen" })).toBe("/app");
  });

  it("maps a figure to the surface that owns it", () => {
    expect(sourceHref({ kind: "figure", figure: "net_worth" })).toBe("/patrimonio");
    expect(sourceHref({ kind: "figure", figure: "fire_progress" })).toBe("/objetivos");
  });

  it("returns null for an unresolvable reference (stays textual)", () => {
    expect(sourceHref({ kind: "section", section: "otra" })).toBeNull();
    expect(sourceHref({ kind: "figure", figure: "not_a_figure" })).toBeNull();
    expect(sourceHref({ kind: "holding", publicId: "" })).toBeNull();
    expect(sourceHref({ kind: "holding", publicId: "wl_hld_a/b" })).toBeNull();
    // A hallucinated id in the retired internal vocabulary — the exact string
    // shape #1318 caught the model inventing — never becomes a clickable chip.
    expect(
      sourceHref({ kind: "holding", publicId: "asset_fidelity_s_p_500_index_fund" }),
    ).toBeNull();
  });
});
