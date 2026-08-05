/**
 * The unvalidated-evidence boundary as code (#1248, PRD #1241). These tests are
 * the invariant's home: they run in CI with no API keys because the boundary is
 * a pure classification plus two predicates, never a prompt paragraph.
 */

import { createChatTools } from "@web/asistente/chat-tools";
import { describe, expect, it } from "vitest";

import {
  consumesUnvalidatedEvidenceBudget,
  createUnvalidatedProposalBudget,
  MAX_UNVALIDATED_PROPOSALS_PER_TURN,
  UNVALIDATED_EVIDENCE_CLASSES,
  unvalidatedEvidenceCapReached,
  unvalidatedEvidenceClassFor,
  unvalidatedEvidenceGateApplies,
  unvalidatedEvidenceRejected,
} from "./unvalidated-evidence-gate";

describe("unvalidated-evidence classification (#1248)", () => {
  it("routes bulk-import tools to the rejected side of the boundary", () => {
    for (const name of [
      "propose_statement_import",
      "propose_balance_history_import",
      "propose_reconstruction",
      "propose_mixed_document_import",
      "propose_reconcile",
    ]) {
      expect(unvalidatedEvidenceClassFor(name), name).toBe("rejects");
    }
  });

  it("lets single-fact proposals accept unvalidated evidence", () => {
    for (const name of [
      "propose_correction",
      "propose_property_valuation_anchor",
      "propose_holding",
      "propose_early_repayment",
    ]) {
      expect(unvalidatedEvidenceClassFor(name), name).toBe("accepts");
    }
  });

  it("leaves gesture-born proposals and reads out of the gate", () => {
    expect(unvalidatedEvidenceClassFor("propose_holding_removal")).toBe("neutral");
    expect(unvalidatedEvidenceClassFor("propose_holding_restoration")).toBe("neutral");
    // And the operation lane (#1374), whose OWN frontier is stronger than the gate:
    // without a validated `holding_event` there is no fact for it to write at all.
    expect(unvalidatedEvidenceClassFor("propose_operation")).toBe("neutral");
    // A read never feeds on a document: unclassified means neutral by default.
    expect(unvalidatedEvidenceClassFor("get_financial_context")).toBe("neutral");
    expect(unvalidatedEvidenceClassFor("suggest_actions")).toBe("neutral");
    expect(unvalidatedEvidenceClassFor("raise_maintainer_alert")).toBe("neutral");
  });

  /**
   * The guardian: every `propose_*` tool the chat catalog exposes must be
   * classified EXPLICITLY. When a new proposal tool lands (e.g. #1245's
   * `propose_early_repayment`) this test fails until its side of the frontier is
   * decided — the boundary cannot be forgotten in the next slice.
   */
  it("forces every propose_* chat tool to declare its side of the frontier", () => {
    const tools = createChatTools({
      runWithStore: async () => {
        throw new Error("no store needed to enumerate the tool set");
      },
      asOf: "2026-07-26",
    });

    const proposalTools = Object.keys(tools).filter((name) =>
      name.startsWith("propose_"),
    );
    expect(proposalTools.length).toBeGreaterThan(0);

    const unclassified = proposalTools.filter(
      (name) => !(name in UNVALIDATED_EVIDENCE_CLASSES),
    );
    expect(unclassified).toEqual([]);

    // And nothing classified has since disappeared from the catalog.
    const stale = Object.keys(UNVALIDATED_EVIDENCE_CLASSES).filter(
      (name) => !(name in tools),
    );
    expect(stale).toEqual([]);
  });
});

describe("unvalidatedEvidenceGateApplies (#1248)", () => {
  it("applies when unvalidated evidence is in play and this turn validated nothing", () => {
    expect(
      unvalidatedEvidenceGateApplies({
        hasUnvalidatedEvidence: true,
        hasValidatedDocumentInThisTurn: false,
      }),
    ).toBe(true);
  });

  it("stands down when THIS turn brought a validated document", () => {
    // Uploading something worthline can read reopens the import path at once.
    expect(
      unvalidatedEvidenceGateApplies({
        hasUnvalidatedEvidence: true,
        hasValidatedDocumentInThisTurn: true,
      }),
    ).toBe(false);
  });

  it("stands down on an ordinary turn with no unvalidated evidence", () => {
    expect(
      unvalidatedEvidenceGateApplies({
        hasUnvalidatedEvidence: false,
        hasValidatedDocumentInThisTurn: false,
      }),
    ).toBe(false);
  });
});

describe("unvalidated-evidence envelopes (#1248)", () => {
  /**
   * The gate is open precisely BECAUSE a sheet was already uploaded, so «upload
   * the file» would be a loop. The copy must name why the sheet does not work,
   * point at the expected format, and offer the original statement instead.
   */
  it("routes the rejection to the deterministic path, never to paying or to a loop", () => {
    const envelope = unvalidatedEvidenceRejected();

    expect(envelope.error).toBe("unvalidated_evidence");
    expect(envelope.message).toMatch(/importar-extracto/);
    expect(envelope.message).toMatch(/extracto original/i);
    expect(envelope.message).toMatch(/dato puntual/i);
    expect(envelope.message).not.toMatch(/sube el fichero|sube el archivo/i);
    // Sibling of the paywall envelope, never the same reason.
    expect(envelope.error).not.toBe("premium_required");
    expect(envelope.message).not.toMatch(/premium/i);
  });

  it("routes the per-turn cap the same way, with its own code", () => {
    const envelope = unvalidatedEvidenceCapReached();

    expect(envelope.error).toBe("unvalidated_evidence_limit");
    expect(envelope.message).toMatch(/importar-extracto/);
    expect(envelope.message).toMatch(/extracto original/i);
    expect(envelope.message).not.toMatch(/sube el fichero|sube el archivo/i);
    expect(envelope.message).not.toMatch(/premium/i);
  });
});

describe("unvalidated proposal budget (#1248)", () => {
  it("hands out exactly one slot per turn, synchronously", () => {
    const budget = createUnvalidatedProposalBudget();

    expect(MAX_UNVALIDATED_PROPOSALS_PER_TURN).toBe(1);
    // Reserve-then-release, never check-then-consume: N concurrent callers must
    // not all see an empty budget before any of them increments it.
    expect(budget.reserve()).toBe(true);
    expect(budget.reserve()).toBe(false);
    expect(budget.reserve()).toBe(false);
  });

  it("gives a slot back when no proposal came out of it", () => {
    const budget = createUnvalidatedProposalBudget();

    expect(budget.reserve()).toBe(true);
    budget.release();
    expect(budget.reserve()).toBe(true);
    expect(budget.reserve()).toBe(false);
  });

  /**
   * The copy names the file neutrally (#1246). Two lanes open this gate now — a
   * readable spreadsheet (#865) and the descriptive reading of a capture — so
   * «esa hoja», true by construction until #1246, would tell someone who uploaded
   * a screenshot about a document that never existed.
   */
  it("never names the unvalidated evidence a spreadsheet", () => {
    for (const { message } of [
      unvalidatedEvidenceRejected(),
      unvalidatedEvidenceCapReached(),
    ]) {
      expect(message).not.toMatch(/hoja/i);
      expect(message).toMatch(/ese archivo/i);
      // Routing survives the rewording: the way out is still the deterministic path.
      expect(message).toContain("/patrimonio/importar-extracto");
    }
  });

  it("only counts a result that really is a prepared proposal", () => {
    // Positive contract: `proposalType` is what every proposal shape carries and
    // what the client parses. A builder failure — however it reports it — must
    // not burn the user's single slot.
    expect(consumesUnvalidatedEvidenceBudget({ proposalType: "holding_creation" })).toBe(
      true,
    );
    expect(consumesUnvalidatedEvidenceBudget({ error: "unknown_holding" })).toBe(false);
    expect(consumesUnvalidatedEvidenceBudget({ error: { code: "bad_request" } })).toBe(
      false,
    );
    expect(consumesUnvalidatedEvidenceBudget({ ok: false, reason: "nope" })).toBe(false);
    expect(consumesUnvalidatedEvidenceBudget({ proposalId: "wl_prp_1" })).toBe(false);
    expect(consumesUnvalidatedEvidenceBudget(null)).toBe(false);
    expect(consumesUnvalidatedEvidenceBudget(undefined)).toBe(false);
  });
});
