/**
 * Reconstruction correction builder + confirm (#1053, PRD #1048 S5): the
 * "Reconstruir historia" depth. The builder persists a `correction` proposal
 * carrying the raw dated balance series and before-values, and the confirm
 * re-projects the (possibly point-edited) series against live data before
 * applying it as ONE atomic batch. Exercised through the same seams as #983.
 */

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { fixedClock } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  confirmCorrectionProposalAction,
  discardCorrectionProposalAction,
} from "./correction-proposal-action";
import { buildReconstructionProposal } from "./reconstruction-proposals";

const TODAY = "2026-07-12";
const clock = fixedClock(`${TODAY}T00:00:00.000Z`);

async function seedMortgage(
  debtModel: "amortizable" | "revolving" = "amortizable",
): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 140_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [{ memberId: "m", shareBps: 10_000 }],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", debtModel);
  if (debtModel === "amortizable") {
    await store.command.createAmortizationPlan(
      {
        annualInterestRate: "0.03",
        disbursementDate: "2026-01-15",
        firstPaymentDate: "2026-02-15",
        id: "plan",
        initialCapitalMinor: 150_000_00,
        liabilityId: "mortgage",
        termMonths: 240,
      },
      { today: TODAY },
    );
  }
  return store;
}

function args(rows: Array<{ date: string; balanceMinor: number }>) {
  return {
    documentName: "cuadro.pdf",
    liabilityId: "mortgage",
    publicHoldingId: "wl_hld_mortgage",
    rows,
  };
}

describe("buildReconstructionProposal (#1053)", () => {
  test("builds a superficie-C reconstruct proposal reconciled to the anchor", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(
      store,
      args([
        { balanceMinor: 145_000_00, date: "2026-04-12" },
        { balanceMinor: 140_000_00, date: TODAY },
      ]),
      TODAY,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.proposalType).toBe("correction");
    expect(built.proposal.mode).toBe("reconstruir");
    expect(built.proposal.anchorMinor).toBe(140_000_00);
    expect(built.proposal.guarantee).toEqual({
      anchorMinor: 140_000_00,
      resultingMinor: 140_000_00,
      state: "reconciled",
    });
    expect(built.proposal.curve.length).toBeGreaterThan(0);
    expect(built.proposal.series.every((point) => point.origin === "assistant")).toBe(
      true,
    );
    store.close();
  });

  test("persists a reconstruct correction fact with the raw series and before-values", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(
      store,
      args([{ balanceMinor: 140_000_00, date: TODAY }]),
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);
    const stored = await store.assistantProposals.read(built.proposal.draft.proposalId);
    expect(stored?.kind).toBe("correction");
    const fact = stored?.documents.flatMap((doc) => doc.facts)[0];
    expect(fact?.kind).toBe("holding_correction");
    if (fact?.kind === "holding_correction" && fact.row.mode === "reconstruct") {
      expect(fact.row.liabilityId).toBe("mortgage");
      expect(fact.row.observations).toEqual([{ balanceMinor: 140_000_00, date: TODAY }]);
      expect(fact.row.before).toEqual({ balanceMinor: 140_000_00 });
    } else {
      throw new Error("expected a reconstruct holding_correction fact");
    }
    expect(JSON.stringify(stored)).not.toContain("rawText");
    store.close();
  });

  test("marks a series that does not reconcile as a mismatch", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(
      store,
      args([{ balanceMinor: 130_000_00, date: TODAY }]),
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);
    expect(built.proposal.guarantee.state).toBe("mismatch");
    store.close();
  });

  test("rejects a non-amortizable debt instead of guessing", async () => {
    const store = await seedMortgage("revolving");
    const built = await buildReconstructionProposal(
      store,
      args([{ balanceMinor: 140_000_00, date: TODAY }]),
      TODAY,
    );
    expect(built).toEqual({
      error: "La deuda no existe o no es amortizable.",
      ok: false,
    });
    store.close();
  });
});

describe("confirmCorrectionProposalAction · reconstruct depth (#1053)", () => {
  test("re-projects and applies the reconstructed series as agent re-baselines", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(
      store,
      args([
        { balanceMinor: 145_000_00, date: "2026-04-12" },
        { balanceMinor: 140_000_00, date: TODAY },
      ]),
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);

    const result = await confirmCorrectionProposalAction(
      built.proposal.draft,
      store,
      clock,
    );

    expect(result).toEqual({ status: "applied" });
    const rebaselines = await store.liabilities.readBalanceRebaselines("mortgage");
    expect(rebaselines.length).toBeGreaterThan(0);
    expect(rebaselines.every((row) => row.source === "agent")).toBe(true);
    expect(
      (await store.assistantProposals.read(built.proposal.draft.proposalId))?.status,
    ).toBe("applied");
    store.close();
  });

  test("honours an edited series that drops a point but still reconciles", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(
      store,
      args([
        { balanceMinor: 145_000_00, date: "2026-04-12" },
        { balanceMinor: 140_000_00, date: TODAY },
      ]),
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);

    // The user excludes the historical point, keeping only the reconciling anchor.
    const result = await confirmCorrectionProposalAction(
      built.proposal.draft,
      [{ balanceMinor: 140_000_00, date: TODAY }],
      store,
      clock,
    );

    expect(result).toEqual({ status: "applied" });
    expect(
      (await store.assistantProposals.read(built.proposal.draft.proposalId))?.status,
    ).toBe("applied");
    store.close();
  });

  test("rejects an edited series that no longer reconciles, persisting nothing", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(
      store,
      args([{ balanceMinor: 140_000_00, date: TODAY }]),
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);

    const result = await confirmCorrectionProposalAction(
      built.proposal.draft,
      [{ balanceMinor: 130_000_00, date: TODAY }],
      store,
      clock,
    );

    expect(result.status).toBe("error");
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);
    expect(
      (await store.assistantProposals.read(built.proposal.draft.proposalId))?.status,
    ).toBe("draft");
    store.close();
  });

  test("discard drops a reconstruct draft with no writes", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(
      store,
      args([{ balanceMinor: 140_000_00, date: TODAY }]),
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);

    const result = await discardCorrectionProposalAction(
      built.proposal.draft,
      store,
      clock,
    );

    expect(result).toEqual({ status: "discarded" });
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);
    store.close();
  });
});
