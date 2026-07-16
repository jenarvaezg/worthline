import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  confirmCorrectionProposalAction,
  discardCorrectionProposalAction,
} from "./correction-proposal-action";
import { buildCorrectionProposal, type CorrectionArgs } from "./correction-proposals";

const TODAY = "2026-07-08";

async function seedLoan(debtModel: "amortizable" | "revolving"): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 6_000_00,
    currency: "EUR",
    id: "loan",
    name: "Préstamo Revolut",
    ownership: [{ memberId: "m", shareBps: 10_000 }],
    type: "debt",
  });
  await store.liabilities.setDebtModel("loan", debtModel);
  if (debtModel === "amortizable") {
    await store.command.createAmortizationPlan(
      {
        annualInterestRate: "0.0589",
        disbursementDate: "2026-05-08",
        firstPaymentDate: "2026-06-08",
        id: "plan1",
        initialCapitalMinor: 6_000_00,
        liabilityId: "loan",
        termMonths: 42,
      },
      { today: TODAY },
    );
  }
  return store;
}

function args(correction: CorrectionArgs["correction"]): CorrectionArgs {
  return { correction, holdingId: "loan", publicHoldingId: "wl_hld_loan" };
}

describe("buildCorrectionProposal (#1051)", () => {
  test("amortizable declare_balance → re-baseline with a live-data revalidation stamp", async () => {
    const store = await seedLoan("amortizable");
    const built = await buildCorrectionProposal(
      store,
      args({
        endDate: "2029-10-08",
        kind: "declare_balance",
        balanceMinor: 5_587_10,
        monthlyPaymentMinor: 158_49,
      }),
      TODAY,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.mode).toBe("solo-desde-hoy");
    expect(built.proposal.guarantee).toEqual({ state: "declared" });

    const stored = await store.assistantProposals.read(built.proposal.draft.proposalId);
    const fact = stored?.documents[0]?.facts[0];
    expect(fact?.kind).toBe("holding_correction");
    if (fact?.kind !== "holding_correction") return;
    expect(fact.row.edits[0]).toMatchObject({ kind: "debt_rebaseline" });
    expect(fact.row.revalidation).toMatchObject({ liabilityId: "loan" });
    store.close();
  });

  test("amortizable declare_balance rejects both rate and payment together", async () => {
    const store = await seedLoan("amortizable");
    const built = await buildCorrectionProposal(
      store,
      args({
        annualRate: "0.06",
        endDate: "2029-10-08",
        kind: "declare_balance",
        balanceMinor: 5_587_10,
        monthlyPaymentMinor: 158_49,
      }),
      TODAY,
    );
    expect(built.ok).toBe(false);
    store.close();
  });

  test("amortizable declare_balance requires an end date", async () => {
    const store = await seedLoan("amortizable");
    const built = await buildCorrectionProposal(
      store,
      args({
        kind: "declare_balance",
        balanceMinor: 5_587_10,
        monthlyPaymentMinor: 158_49,
      }),
      TODAY,
    );
    expect(built.ok).toBe(false);
    store.close();
  });

  test("revolving declare_balance → balance anchor", async () => {
    const store = await seedLoan("revolving");
    const built = await buildCorrectionProposal(
      store,
      args({ kind: "declare_balance", balanceMinor: 5_000_00 }),
      TODAY,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const fact = (await store.assistantProposals.read(built.proposal.draft.proposalId))
      ?.documents[0]?.facts[0];
    if (fact?.kind !== "holding_correction") throw new Error("expected correction fact");
    expect(fact.row.edits[0]?.kind).toBe("balance_anchor");
    store.close();
  });

  test("change_debt_model records the model transition and is a no-op when unchanged", async () => {
    const store = await seedLoan("amortizable");
    const changed = await buildCorrectionProposal(
      store,
      args({ debtModel: "revolving", kind: "change_debt_model" }),
      TODAY,
    );
    expect(changed.ok).toBe(true);
    if (changed.ok) {
      expect(changed.proposal.edits[0]).toMatchObject({ label: "Modelo de deuda" });
    }
    const noop = await buildCorrectionProposal(
      store,
      args({ debtModel: "amortizable", kind: "change_debt_model" }),
      TODAY,
    );
    expect(noop.ok).toBe(false);
    store.close();
  });

  test("edit_config renames the holding", async () => {
    const store = await seedLoan("revolving");
    const built = await buildCorrectionProposal(
      store,
      args({ kind: "edit_config", name: "Préstamo personal Revolut" }),
      TODAY,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const fact = (await store.assistantProposals.read(built.proposal.draft.proposalId))
      ?.documents[0]?.facts[0];
    if (fact?.kind !== "holding_correction") throw new Error("expected correction fact");
    expect(fact.row.edits[0]).toMatchObject({
      kind: "liability_config",
      patch: { name: "Préstamo personal Revolut" },
    });
    store.close();
  });

  test("an unknown holding is reported honestly", async () => {
    const store = await seedLoan("amortizable");
    const built = await buildCorrectionProposal(
      store,
      {
        correction: { balanceMinor: 1, kind: "declare_balance" },
        holdingId: "ghost",
        publicHoldingId: "wl_hld_ghost",
      },
      TODAY,
    );
    expect(built.ok).toBe(false);
    store.close();
  });
});

describe("correction proposal server actions (#1051)", () => {
  const clock = { today: () => TODAY };

  async function buildRevolvingCorrection(store: WorthlineStore) {
    const built = await buildCorrectionProposal(
      store,
      args({ kind: "declare_balance", balanceMinor: 5_000_00 }),
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);
    return built.proposal.draft;
  }

  test("confirm applies the anchor with agent provenance and marks it applied", async () => {
    const store = await seedLoan("revolving");
    const draft = await buildRevolvingCorrection(store);

    const result = await confirmCorrectionProposalAction(draft, store, clock);

    expect(result).toEqual({ status: "applied" });
    expect(await store.liabilities.readBalanceAnchors("loan")).toHaveLength(1);
    expect((await store.assistantProposals.read(draft.proposalId))?.status).toBe(
      "applied",
    );
    store.close();
  });

  test("discard drops the draft with no writes", async () => {
    const store = await seedLoan("revolving");
    const draft = await buildRevolvingCorrection(store);

    const result = await discardCorrectionProposalAction(draft, store, clock);

    expect(result).toEqual({ status: "discarded" });
    expect(await store.liabilities.readBalanceAnchors("loan")).toHaveLength(0);
    expect((await store.assistantProposals.read(draft.proposalId))?.status).toBe(
      "discarded",
    );
    store.close();
  });

  test("an unrecognized draft is reported honestly", async () => {
    const store = await seedLoan("revolving");
    const result = await confirmCorrectionProposalAction({ nope: true }, store, clock);
    expect(result).toEqual({ message: "Propuesta no reconocida.", status: "error" });
    store.close();
  });
});
