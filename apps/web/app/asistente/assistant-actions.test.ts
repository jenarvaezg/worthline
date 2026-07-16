/**
 * Typed quick-action + source-destination tests (#631, ADR 0053/0052). The
 * model PROPOSES actions; the app renders only what validates against the typed
 * set, and only internal destinations — the model never supplies a raw URL.
 */

import {
  parseCorrectionProposal,
  parseQuickActions,
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
  it("maps a holding to its worthline detail surface", () => {
    expect(sourceHref({ kind: "holding", internalId: "abc" })).toBe(
      "/patrimonio/abc/editar",
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
    expect(sourceHref({ kind: "holding", internalId: "" })).toBeNull();
    expect(sourceHref({ kind: "holding", internalId: "a/b" })).toBeNull();
  });
});
