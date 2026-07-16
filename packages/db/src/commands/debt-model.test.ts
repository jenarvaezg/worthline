/**
 * Debt-model change command (#1051): the one write #997 left open. Flip a
 * liability's model and re-cut its curve under the new model, in one command.
 * Exercised directly against an in-memory store, like the other command tests.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  executeChangeDebtModelCommand,
  executeCreateAmortizationPlanCommand,
} from "./index";

const TODAY = "2026-07-02";

async function debtsAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey)
    ?.debts.amountMinor;
}

async function seedAmortizableMortgageWithPlan(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 150_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", "amortizable");
  await executeCreateAmortizationPlanCommand(store, {
    today: TODAY,
    input: {
      annualInterestRate: "0.03",
      disbursementDate: "2026-01-15",
      firstPaymentDate: "2026-02-15",
      id: "plan1",
      initialCapitalMinor: 150_000_00,
      liabilityId: "mortgage",
      termMonths: 240,
    },
  });
  return store;
}

describe("change debt model command (#1051)", () => {
  test("amortizable → revolving re-cuts existing snapshots under the anchor curve", async () => {
    const store = await seedAmortizableMortgageWithPlan();
    const amortizableAt0315 = (await debtsAt(store, "2026-03-15"))!;
    // A revolving anchor fact declared in the past (raw persist, no ripple yet).
    await store.command.addBalanceAnchor(
      {
        anchorDate: "2026-02-15",
        balanceMinor: 100_000_00,
        id: "anchor1",
        liabilityId: "mortgage",
      },
      { today: TODAY },
    );

    const result = await executeChangeDebtModelCommand(store, {
      debtModel: "revolving",
      liabilityId: "mortgage",
      today: TODAY,
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(await store.liabilities.readDebtModel("mortgage")).toBe("revolving");
    // Snapshots on/after the anchor now match the revolving curve, not the plan's.
    expect(await debtsAt(store, "2026-03-15")).toBe(
      await store.liabilities.debtBalanceAtDate("mortgage", "2026-03-15"),
    );
    expect(await debtsAt(store, "2026-03-15")).not.toBe(amortizableAt0315);

    store.close();
  });

  test("a no-op flip (same model) changes nothing", async () => {
    const store = await seedAmortizableMortgageWithPlan();
    const before = await debtsAt(store, "2026-03-15");

    const result = await executeChangeDebtModelCommand(store, {
      debtModel: "amortizable",
      liabilityId: "mortgage",
      today: TODAY,
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(await store.liabilities.readDebtModel("mortgage")).toBe("amortizable");
    expect(await debtsAt(store, "2026-03-15")).toBe(before);

    store.close();
  });

  test("revolving → amortizable re-cuts the curve from the plan", async () => {
    const store = await seedAmortizableMortgageWithPlan();
    // Move it to revolving first (anchor in the past), then back to amortizable.
    await store.command.addBalanceAnchor(
      {
        anchorDate: "2026-02-15",
        balanceMinor: 100_000_00,
        id: "anchor1",
        liabilityId: "mortgage",
      },
      { today: TODAY },
    );
    await executeChangeDebtModelCommand(store, {
      debtModel: "revolving",
      liabilityId: "mortgage",
      today: TODAY,
    });

    const result = await executeChangeDebtModelCommand(store, {
      debtModel: "amortizable",
      liabilityId: "mortgage",
      today: TODAY,
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(await debtsAt(store, "2026-03-15")).toBe(
      await store.liabilities.debtBalanceAtDate("mortgage", "2026-03-15"),
    );

    store.close();
  });
});
