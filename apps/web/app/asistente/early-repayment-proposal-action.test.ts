import {
  captureDailySnapshotForWorkspace,
  createInMemoryStore,
  type WorthlineStore,
} from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  confirmEarlyRepaymentProposalAction,
  discardEarlyRepaymentProposalAction,
} from "./early-repayment-proposal-action";
import { buildEarlyRepaymentProposal } from "./early-repayment-proposals";

const TODAY = "2026-07-26";
const clock = { today: () => TODAY, now: () => `${TODAY}T10:00:00.000Z` };

async function seed(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 4_200_00,
    currency: "EUR",
    id: "loan",
    name: "Préstamo Revolut",
    ownership: [{ memberId: "m", shareBps: 10_000 }],
    type: "debt",
  });
  await store.liabilities.setDebtModel("loan", "amortizable");
  await store.command.createAmortizationPlan(
    {
      annualInterestRate: "0.089",
      disbursementDate: "2025-08-15",
      firstPaymentDate: "2025-09-15",
      id: "plan",
      initialCapitalMinor: 5_000_00,
      liabilityId: "loan",
      termMonths: 36,
    },
    { today: TODAY },
  );
  return store;
}

async function draft(store: WorthlineStore, overrides: Record<string, unknown> = {}) {
  const built = await buildEarlyRepaymentProposal(
    store,
    {
      amountMinor: 91_32,
      liabilityId: "loan",
      mode: "reduce-term",
      publicHoldingId: "wl_hld_loan",
      repaymentDate: "2026-07-20",
      ...overrides,
    },
    TODAY,
  );
  if (!built.ok) throw new Error(`build failed: ${built.error}`);
  return built.proposal;
}

describe("confirmEarlyRepaymentProposalAction (#1245)", () => {
  test("writes the repayment with source agent and resolves the draft", async () => {
    const store = await seed();
    const proposal = await draft(store);

    const result = await confirmEarlyRepaymentProposalAction(
      proposal.draft,
      store,
      clock,
    );

    expect(result).toEqual({ status: "applied" });
    expect(await store.liabilities.readEarlyRepayments("plan")).toMatchObject([
      {
        amountMinor: 9132,
        mode: "reduce-term",
        repaymentDate: "2026-07-20",
        source: "agent",
      },
    ]);
    expect(await store.assistantProposals.read(proposal.draft.proposalId)).toMatchObject({
      status: "applied",
    });
    store.close();
  });

  test("the ripple moves the curve from the repayment on, leaving earlier history verbatim", async () => {
    const store = await seed();
    const before = {
      may: await store.liabilities.debtBalanceAtDate("loan", "2026-05-15"),
      june: await store.liabilities.debtBalanceAtDate("loan", "2026-06-15"),
      today: await store.liabilities.debtBalanceAtDate("loan", TODAY),
    };
    const proposal = await draft(store);

    await confirmEarlyRepaymentProposalAction(proposal.draft, store, clock);

    // Before the repayment's month boundary: untouched.
    expect(await store.liabilities.debtBalanceAtDate("loan", "2026-05-15")).toBe(
      before.may,
    );
    expect(await store.liabilities.debtBalanceAtDate("loan", "2026-06-15")).toBe(
      before.june,
    );
    // From it on: 91,32 € lower.
    expect(await store.liabilities.debtBalanceAtDate("loan", TODAY)).toBe(
      before.today - 9132,
    );
    store.close();
  });

  test("the ripple rewrites the persisted snapshots from the repayment on", async () => {
    // The derived read above proves the curve; this proves the STORED history the
    // product reads — the ripple ran, and only forward. The captured snapshot of
    // today (after the 20-jul repayment) is the one that must move; the cuota
    // boundary the lump belongs to (15-jul) is BEFORE the money left, so its
    // figure is untouchable history (#1291).
    const store = await seed();
    await store.command.backfillHistoricalSnapshots(TODAY);
    await captureDailySnapshotForWorkspace(store, clock.now());
    const debtsAt = async (dateKey: string) =>
      (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey)
        ?.debts.amountMinor;
    const beforeJune = await debtsAt("2026-06-15");
    const beforeJuly = await debtsAt("2026-07-15");
    const beforeToday = await debtsAt(TODAY);
    expect(beforeJune).toBeGreaterThan(0);
    expect(beforeJuly).toBeGreaterThan(0);
    expect(beforeToday).toBeGreaterThan(0);
    const proposal = await draft(store);

    await confirmEarlyRepaymentProposalAction(proposal.draft, store, clock);

    expect(await debtsAt("2026-06-15")).toBe(beforeJune);
    expect(await debtsAt("2026-07-15")).toBe(beforeJuly);
    expect(await debtsAt(TODAY)).toBe((beforeToday ?? 0) - 9132);
    store.close();
  });

  test("a repayment registered by hand in the meantime blocks the confirm", async () => {
    const store = await seed();
    const proposal = await draft(store);
    await store.command.addEarlyRepayment(
      {
        amountMinor: 91_32,
        id: "byhand",
        mode: "reduce-term",
        planId: "plan",
        repaymentDate: "2026-07-20",
      },
      { liabilityId: "loan", today: TODAY },
    );

    const result = await confirmEarlyRepaymentProposalAction(
      proposal.draft,
      store,
      clock,
    );

    expect(result.status).toBe("error");
    // Only the hand-typed row survives: the confirm wrote nothing.
    expect(await store.liabilities.readEarlyRepayments("plan")).toMatchObject([
      { id: "byhand", source: "manual" },
    ]);
    expect(await store.assistantProposals.read(proposal.draft.proposalId)).toMatchObject({
      status: "draft",
    });
    store.close();
  });

  test("a curve that moved since drafting fails the staleness guard, not the duplicate one", async () => {
    const store = await seed();
    const proposal = await draft(store);
    // Not a duplicate repayment — an unrelated fact that moves the very balance the
    // preview's arithmetic was built on. The draft must not be replayed blindly.
    await store.command.addInterestRateRevision(
      {
        id: "rev",
        newAnnualInterestRate: "0.02",
        planId: "plan",
        revisionDate: "2026-02-15",
      },
      { liabilityId: "loan", today: TODAY },
    );

    const result = await confirmEarlyRepaymentProposalAction(
      proposal.draft,
      store,
      clock,
    );

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.message).toMatch(/cambió|propuesta/i);
    expect(await store.liabilities.readEarlyRepayments("plan")).toEqual([]);
    expect(await store.assistantProposals.read(proposal.draft.proposalId)).toMatchObject({
      status: "draft",
    });
    store.close();
  });

  test("a debt that stopped being amortizable gets the honest route, not a raw failure", async () => {
    const store = await seed();
    const proposal = await draft(store);
    await store.command.changeDebtModel("loan", "revolving", { today: TODAY });

    const result = await confirmEarlyRepaymentProposalAction(
      proposal.draft,
      store,
      clock,
    );

    expect(result.status).toBe("error");
    // The re-projection speaks first: the message names the model and the way out.
    expect(result.status === "error" && result.message).toMatch(/revolving/i);
    expect(await store.liabilities.readEarlyRepayments("plan")).toEqual([]);
    store.close();
  });

  test("an already resolved draft cannot be confirmed twice", async () => {
    const store = await seed();
    const proposal = await draft(store);
    await confirmEarlyRepaymentProposalAction(proposal.draft, store, clock);

    const again = await confirmEarlyRepaymentProposalAction(proposal.draft, store, clock);

    expect(again.status).toBe("error");
    expect(await store.liabilities.readEarlyRepayments("plan")).toHaveLength(1);
    store.close();
  });

  test("discarding resolves the draft and never writes", async () => {
    const store = await seed();
    const proposal = await draft(store);

    const result = await discardEarlyRepaymentProposalAction(proposal.draft, store);

    expect(result).toEqual({ status: "discarded" });
    expect(await store.liabilities.readEarlyRepayments("plan")).toEqual([]);
    store.close();
  });

  test("an unrecognized draft is rejected before any store cycle", async () => {
    const store = await seed();

    expect(
      await confirmEarlyRepaymentProposalAction({ nope: true }, store, clock),
    ).toMatchObject({ status: "error" });
    expect(await store.liabilities.readEarlyRepayments("plan")).toEqual([]);
    store.close();
  });
});
