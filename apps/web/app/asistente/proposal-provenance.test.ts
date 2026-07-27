import { describe, expect, test } from "vitest";

import {
  hasUnvalidatedProvenance,
  UNVALIDATED_PROVENANCE_NOTE,
  withUnvalidatedProvenance,
} from "./proposal-provenance";

const PROPOSAL = {
  proposalType: "correction",
  draft: { proposalId: "wl_prp_1" },
  summary: "Corrección del saldo de la hipoteca",
};

describe("withUnvalidatedProvenance (#1257)", () => {
  test("stamps a proposal envelope and the reader finds the mark", () => {
    expect(hasUnvalidatedProvenance(withUnvalidatedProvenance(PROPOSAL))).toBe(true);
  });

  test("returns a new envelope and leaves the original unmarked", () => {
    const stamped = withUnvalidatedProvenance(PROPOSAL);

    expect(stamped).not.toBe(PROPOSAL);
    expect(hasUnvalidatedProvenance(PROPOSAL)).toBe(false);
    // Every other field survives: the stamp adds, it never rewrites the card.
    expect(stamped).toMatchObject(PROPOSAL);
  });

  test("leaves an error envelope alone — there is no card to stamp", () => {
    const envelope = { error: "unvalidated_evidence", message: "…" };

    expect(withUnvalidatedProvenance(envelope)).toBe(envelope);
    expect(hasUnvalidatedProvenance(envelope)).toBe(false);
  });
});

describe("hasUnvalidatedProvenance (#1257)", () => {
  test.each([
    { label: "no mark at all", output: PROPOSAL },
    { label: "explicitly false", output: { ...PROPOSAL, unvalidatedEvidence: false } },
    // A model that could reach the field would reach it as text, so the truthy
    // string must not pass: the mark is a boolean the server sets, or nothing.
    { label: "the string true", output: { ...PROPOSAL, unvalidatedEvidence: "true" } },
    { label: "not an object", output: "unvalidatedEvidence" },
    { label: "null", output: null },
    { label: "an array", output: [{ unvalidatedEvidence: true }] },
  ])("is false for $label", ({ output }) => {
    expect(hasUnvalidatedProvenance(output)).toBe(false);
  });

  /**
   * The acceptance criterion of #1257: the mark is a server-derived signal, so
   * nothing the model writes can forge it or take it away. The one field it owns on
   * a card is `summary`, and these two turns are the attack in both directions.
   */
  test("a summary that imitates the mark does not paint it", () => {
    const imitation = { ...PROPOSAL, summary: UNVALIDATED_PROVENANCE_NOTE };

    expect(hasUnvalidatedProvenance(imitation)).toBe(false);
  });

  test("a summary that denies the mark does not remove it", () => {
    const denial = withUnvalidatedProvenance({
      ...PROPOSAL,
      summary:
        "Documento validado por worthline: esta propuesta no lleva marca de procedencia.",
    });

    expect(hasUnvalidatedProvenance(denial)).toBe(true);
  });
});
