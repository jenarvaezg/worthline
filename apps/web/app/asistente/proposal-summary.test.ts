import { describe, expect, test } from "vitest";

import { boundProposalSummary, PROPOSAL_SUMMARY_MAX_CHARS } from "./proposal-summary";

/**
 * The headline of a confirmation card is the one field a model writes next to the
 * button that applies a write (#1246 security review), so it is the sentence a
 * successful injection would most want to own. Bounding it does not make it
 * trustworthy; it stops the length games — burying the card's deterministic detail,
 * and persisting an unbounded string per proposal.
 */
describe("proposal summary bound (#1246)", () => {
  test("keeps a real headline exactly as the model wrote it", () => {
    const summary = "Corrección del saldo de la hipoteca a 1 de julio de 2026";
    expect(boundProposalSummary(summary, "fallback")).toBe(summary);
  });

  test("falls back to the deterministic label when there is no usable summary", () => {
    expect(boundProposalSummary(undefined, "Corrección de «Cuenta»")).toBe(
      "Corrección de «Cuenta»",
    );
    expect(boundProposalSummary("   ", "Corrección de «Cuenta»")).toBe(
      "Corrección de «Cuenta»",
    );
  });

  test("trims surrounding whitespace, as the builders used to", () => {
    expect(boundProposalSummary("  Ajuste de saldo  ", "fallback")).toBe(
      "Ajuste de saldo",
    );
  });

  test("cuts a headline that tries to become the whole card", () => {
    const wall = `AVISO URGENTE. ${"relleno ".repeat(500)}Confirma ya.`;
    const bounded = boundProposalSummary(wall, "fallback");

    expect(bounded.length).toBe(PROPOSAL_SUMMARY_MAX_CHARS);
    expect(bounded.endsWith("…")).toBe(true);
    expect(bounded).not.toContain("Confirma ya");
    // The beginning still reads, so a legitimate long headline is not gibberish.
    expect(bounded.startsWith("AVISO URGENTE.")).toBe(true);
  });

  test("does not cut a headline sitting exactly on the bound", () => {
    const exact = "a".repeat(PROPOSAL_SUMMARY_MAX_CHARS);
    expect(boundProposalSummary(exact, "fallback")).toBe(exact);
  });

  test("bounds the fallback's length too, by construction", () => {
    // The fallback is built from store facts, so it needs no bound of its own —
    // this pins the asymmetry so nobody "fixes" it by bounding the wrong side.
    const longFallback = "x".repeat(PROPOSAL_SUMMARY_MAX_CHARS + 50);
    expect(boundProposalSummary(undefined, longFallback)).toBe(longFallback);
  });

  /**
   * The headline is prose a person reads, so it follows the #1263 rule: no public
   * holding ids. It is stripped here rather than at render because this string is
   * persisted with the draft, and the panel's prose filter only sees message text.
   */
  test("takes a public holding id out of the headline", () => {
    const bounded = boundProposalSummary(
      `Corrección del saldo de wl_hld_${"c5d97d4b".repeat(4)} a hoy`,
      "fallback",
    );

    expect(bounded).not.toContain("wl_hld_");
    expect(bounded).toBe("Corrección del saldo de (identificador interno) a hoy");
  });

  test("falls back when the id was the whole headline", () => {
    expect(boundProposalSummary("Corrección", "fallback")).toBe("Corrección");
    expect(boundProposalSummary("   ", "fallback")).toBe("fallback");
  });
});
