/**
 * Correction proposal apply (#1051, PRD #1048): the anchor-only depth of
 * "correct a holding from the chat". Exercised at the command-host level like
 * the other proposal applies — the store persists the correction plan, the
 * command applies it atomically, revalidating against live data first.
 */

import type {
  AddBalanceRebaselineInput,
  AnchorOnlyCorrectionPlan,
  CorrectionPlan,
  WorthlineStore,
} from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import { executeCreateAmortizationPlanCommand } from "./index";

const TODAY = "2026-07-08";

async function debtsAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey)
    ?.debts.amountMinor;
}

async function seedDriftedMortgage(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 6_000_00,
    currency: "EUR",
    id: "loan",
    name: "Préstamo Revolut",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "debt",
  });
  await store.liabilities.setDebtModel("loan", "amortizable");
  await executeCreateAmortizationPlanCommand(store, {
    today: TODAY,
    input: {
      annualInterestRate: "0.0589",
      disbursementDate: "2026-05-08",
      firstPaymentDate: "2026-06-08",
      id: "plan1",
      initialCapitalMinor: 6_000_00,
      liabilityId: "loan",
      termMonths: 42,
    },
  });
  return store;
}

async function createRebaselineCorrection(
  store: WorthlineStore,
  plan: CorrectionPlan,
): Promise<string> {
  const proposal = await store.assistantProposals.create({ kind: "correction" });
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      name: "declaración-del-usuario",
      provenance: "user",
      sha256: "a".repeat(64),
    },
    facts: [{ kind: "holding_correction", row: plan }],
  });
  return proposal.id;
}

function rebaselinePlan(
  overrides?: Partial<AnchorOnlyCorrectionPlan>,
): AnchorOnlyCorrectionPlan {
  return {
    edits: [
      {
        before: { balanceMinor: 5_586_30 },
        input: {
          baselineDate: TODAY,
          endDate: "2029-10-08",
          id: "reb1",
          liabilityId: "loan",
          monthlyPaymentMinor: 158_49,
          nextPaymentDate: "2026-08-08",
          outstandingBalanceMinor: 5_587_10,
          source: "agent",
        },
        kind: "debt_rebaseline",
      },
    ],
    holding: "wl_hld_loan",
    mode: "anchor-only",
    ...overrides,
  };
}

describe("correction proposal apply (#1051)", () => {
  test("round-trips a holding_correction fact without raw document text", async () => {
    const store = await seedDriftedMortgage();
    const proposalId = await createRebaselineCorrection(store, rebaselinePlan());

    const stored = await store.assistantProposals.read(proposalId);
    expect(stored).toMatchObject({
      kind: "correction",
      documents: [{ facts: [{ kind: "holding_correction" }] }],
      status: "draft",
    });
    expect(JSON.stringify(stored)).not.toContain("rawText");
    store.close();
  });

  test("applies an anchor-only re-baseline atomically and marks the proposal applied", async () => {
    const store = await seedDriftedMortgage();
    const proposalId = await createRebaselineCorrection(store, rebaselinePlan());

    await store.command.applyAssistantCorrectionProposal({ proposalId, today: TODAY });

    expect((await store.assistantProposals.read(proposalId))?.status).toBe("applied");
    expect(await store.liabilities.readBalanceRebaselines("loan")).toHaveLength(1);
    // The declared balance is what the loan reads today after the correction.
    expect(await store.liabilities.debtBalanceAtDate("loan", TODAY)).toBe(5_587_10);
    store.close();
  });

  test("a stale draft fails honestly and persists nothing", async () => {
    const store = await seedDriftedMortgage();
    // The draft was armed against a balance that no longer matches live data.
    const proposalId = await createRebaselineCorrection(
      store,
      rebaselinePlan({
        revalidation: {
          asOf: TODAY,
          expectedBalanceMinor: 9_999_99,
          liabilityId: "loan",
        },
      }),
    );

    await expect(
      store.command.applyAssistantCorrectionProposal({ proposalId, today: TODAY }),
    ).rejects.toThrow(/cambió|stale/i);

    expect((await store.assistantProposals.read(proposalId))?.status).toBe("draft");
    expect(await store.liabilities.readBalanceRebaselines("loan")).toHaveLength(0);
    store.close();
  });

  test("the past before the anchor stays unmodelled (ADR 0056)", async () => {
    const store = await seedDriftedMortgage();
    const before0608 = await debtsAt(store, "2026-06-08");
    const proposalId = await createRebaselineCorrection(store, rebaselinePlan());

    await store.command.applyAssistantCorrectionProposal({ proposalId, today: TODAY });

    // A snapshot before the baseline date keeps the original curve; only the
    // present and forward move.
    expect(await debtsAt(store, "2026-06-08")).toBe(before0608);
    store.close();
  });
});

/** The reconstruct depth (#1053): a document-driven dated balance series. */
function reconstructPlan(): CorrectionPlan {
  return {
    before: { balanceMinor: 5_586_30 },
    holding: "wl_hld_loan",
    liabilityId: "loan",
    mode: "reconstruct",
    observations: [
      { balanceMinor: 5_760_00, date: "2026-06-08" },
      { balanceMinor: 5_587_10, date: "2026-07-08" },
    ],
  };
}

function reconstructRebaselines(): AddBalanceRebaselineInput[] {
  return [
    {
      annualInterestRate: "0.0589",
      baselineDate: "2026-06-08",
      endDate: "2029-10-08",
      id: "reb-0608",
      liabilityId: "loan",
      nextPaymentDate: "2026-07-08",
      outstandingBalanceMinor: 5_760_00,
      source: "agent",
      startsAtBaseline: false,
    },
    {
      annualInterestRate: "0.0589",
      baselineDate: "2026-07-08",
      endDate: "2029-10-08",
      id: "reb-0708",
      liabilityId: "loan",
      nextPaymentDate: "2026-08-08",
      outstandingBalanceMinor: 5_587_10,
      source: "agent",
      startsAtBaseline: false,
    },
  ];
}

describe("correction proposal apply · reconstruct depth (#1053)", () => {
  test("applies the reconstructed series as ONE atomic batch and marks it applied", async () => {
    const store = await seedDriftedMortgage();
    const proposalId = await createRebaselineCorrection(store, reconstructPlan());

    await store.command.applyAssistantCorrectionProposal({
      proposalId,
      reconstruct: { liabilityId: "loan", rebaselines: reconstructRebaselines() },
      today: TODAY,
    });

    expect((await store.assistantProposals.read(proposalId))?.status).toBe("applied");
    // Both re-baselines land, and the endpoint reconciles to the last balance.
    expect(await store.liabilities.readBalanceRebaselines("loan")).toHaveLength(2);
    expect(await store.liabilities.debtBalanceAtDate("loan", TODAY)).toBe(5_587_10);
    // The reconstructed past date is now modelled (unlike anchor-only).
    expect(await store.liabilities.debtBalanceAtDate("loan", "2026-06-08")).toBe(
      5_760_00,
    );
    store.close();
  });

  test("the applied proposal keeps the raw series and before-values, no ripple leak", async () => {
    const store = await seedDriftedMortgage();
    const proposalId = await createRebaselineCorrection(store, reconstructPlan());

    await store.command.applyAssistantCorrectionProposal({
      proposalId,
      reconstruct: { liabilityId: "loan", rebaselines: reconstructRebaselines() },
      today: TODAY,
    });

    const applied = await store.assistantProposals.read(proposalId);
    const fact = applied?.documents.flatMap((doc) => doc.facts)[0];
    expect(fact?.kind).toBe("holding_correction");
    if (fact?.kind === "holding_correction" && fact.row.mode === "reconstruct") {
      expect(fact.row.observations).toHaveLength(2);
      expect(fact.row.before).toEqual({ balanceMinor: 5_586_30 });
    } else {
      throw new Error("expected a reconstruct holding_correction fact");
    }
    store.close();
  });
});
