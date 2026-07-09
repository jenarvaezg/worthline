/**
 * Daily capture values debts on their curve, not the stored balance.
 *
 * The cron/self-heal capture (`captureDailySnapshotForWorkspace`) froze every
 * liability at `current_balance_minor` — a value nothing advances on payment
 * dates — while the ripples value the same debt from its amortization curve.
 * A month boundary therefore never moved the captured debt. The capture must
 * value each liability through `debtBalanceAtDate` on the capture date:
 * plan-derived for amortizable, anchors for revolving/informal, and the stored
 * balance as the model-less fallback.
 */

import type { WorthlineStore } from "@db/index";

import { captureDailySnapshotForWorkspace, createInMemoryStore } from "@db/index";
import { describe, expect, test } from "vitest";

const TODAY = "2026-07-02";
const NOW = `${TODAY}T21:00:00.000Z`;

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  // Some cash so the portfolio is never empty.
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 10_000_00,
    id: "cash",
    liquidityTier: "cash",
    name: "Cuenta",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "cash",
  });
  await store.liabilities.createLiability({
    balanceMinor: 100_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", "amortizable");
  await store.createAmortizationPlanAndRipple(
    {
      annualInterestRate: "0.03",
      disbursementDate: "2026-01-15",
      firstPaymentDate: "2026-02-15",
      id: "plan1",
      initialCapitalMinor: 150_000_00,
      liabilityId: "mortgage",
      termMonths: 240,
    },
    { today: TODAY },
  );
}

async function capturedDebtRow(
  store: WorthlineStore,
  holdingId: string,
): Promise<number | undefined> {
  const rows = await store.snapshots.readSnapshotHoldings({
    holdingId,
    kind: "liability",
  });
  return rows.find((row) => row.dateKey === TODAY)?.valueMinor;
}

describe("daily capture — debt curve valuation", () => {
  test("captures the plan-derived balance, not the stored one", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const expected = await store.liabilities.debtBalanceAtDate("mortgage", TODAY);
    // Premise guard: the curve and the stored balance must actually disagree,
    // otherwise this test cannot distinguish the two sources.
    expect(expected).not.toBe(100_000_00);

    await captureDailySnapshotForWorkspace(store, NOW);

    expect(await capturedDebtRow(store, "mortgage")).toBe(expected);
    const snapshot = (await store.snapshots.readSnapshots()).find(
      (candidate) => candidate.dateKey === TODAY,
    );
    expect(snapshot?.debts.amountMinor).toBe(expected);
    store.close();
  });

  test("a model-less liability keeps its stored balance", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.liabilities.createLiability({
      balanceMinor: 15_000_00,
      currency: "EUR",
      id: "cunao",
      name: "Deuda Cuñao",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "debt",
    });

    await captureDailySnapshotForWorkspace(store, NOW);

    expect(await capturedDebtRow(store, "cunao")).toBe(15_000_00);
    store.close();
  });
});
