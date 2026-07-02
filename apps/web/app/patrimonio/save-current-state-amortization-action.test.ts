/**
 * Action-level tests for saveCurrentStateAmortizationAction (ADR 0056, PRD #670
 * S2, #677) — «alta por estado actual» on the advanced edit surface.
 *
 * The #676 review's CRITICAL requirement: a current-state debt is never
 * persisted with a balance re-baseline but no amortization plan row (revisions
 * and early repayments hang off `plan_id`). These tests assert BOTH land
 * together, atomically enough that the ripple's snapshot for today reflects the
 * declared balance, and that the fact set is exactly the `startsAtBaseline`
 * re-baseline + plan pair the domain composition test proves equivalent to.
 */
import { createInMemoryStore } from "@worthline/db";
import type { WorthlineStore } from "@worthline/db";
import { calculateNetWorth, fixedClock, type Clock } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { saveCurrentStateAmortizationAction } from "./actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

async function runAction(
  fd: FormData,
  store: WorthlineStore,
  clock: Clock,
): Promise<string> {
  try {
    await saveCurrentStateAmortizationAction(fd, store, clock);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

const TODAY = "2026-07-02";
const CLOCK = fixedClock(TODAY);

async function seedAmortizableMortgage(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 1, // deliberately stale — the current-state save must overwrite it
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", "amortizable");
  return store;
}

describe("saveCurrentStateAmortizationAction — baseline debt", () => {
  test("persists a plan row AND a startsAtBaseline re-baseline together (#676 review)", async () => {
    const store = await seedAmortizableMortgage();

    const url = await runAction(
      form({
        currentUrl: "/patrimonio/mortgage/editar",
        id: "mortgage",
        csAnnualRate: "2,35",
        csEndDate: "2032-06-30",
        csInputMode: "rate",
        csNextPaymentDate: "2026-08-01",
        csOutstandingBalance: "118.000,00",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("current_state_debt_saved");

    const plan = await store.liabilities.readAmortizationPlan("mortgage");
    expect(plan).toMatchObject({
      disbursementDate: TODAY,
      firstPaymentDate: "2026-08-01",
      initialCapitalMinor: 118_000_00,
    });

    const rebaselines = await store.liabilities.readBalanceRebaselines("mortgage");
    expect(rebaselines).toHaveLength(1);
    expect(rebaselines[0]).toMatchObject({
      baselineDate: TODAY,
      outstandingBalanceMinor: 118_000_00,
      startsAtBaseline: true,
    });

    // Today's net worth reflects the declared balance immediately, not the
    // stale value the liability was created with.
    const liability = (await store.liabilities.readLiabilities()).find(
      (l) => l.id === "mortgage",
    )!;
    expect(liability.currentBalance.amountMinor).toBe(118_000_00);

    store.close();
  });

  test("stores the optional original-signing-date metadata on the plan row", async () => {
    const store = await seedAmortizableMortgage();

    await runAction(
      form({
        id: "mortgage",
        csAnnualRate: "2,35",
        csEndDate: "2032-06-30",
        csInputMode: "rate",
        csNextPaymentDate: "2026-08-01",
        csOriginalSigningDate: "2004-03-01",
        csOutstandingBalance: "118.000,00",
      }),
      store,
      CLOCK,
    );

    const plan = await store.liabilities.readAmortizationPlan("mortgage");
    expect(plan?.originalSigningDate).toBe("2004-03-01");

    store.close();
  });

  test("rejects an infeasible cuota without persisting anything", async () => {
    const store = await seedAmortizableMortgage();

    const url = await runAction(
      form({
        id: "mortgage",
        csEndDate: "2032-06-30",
        csInputMode: "payment",
        csMonthlyPayment: "1,00",
        csNextPaymentDate: "2026-08-01",
        csOutstandingBalance: "118.000,00",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.liabilities.readAmortizationPlan("mortgage")).toBeNull();
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);

    store.close();
  });

  test("refuses to overwrite an existing amortization plan", async () => {
    const store = await seedAmortizableMortgage();
    await store.createAmortizationPlanAndRipple(
      {
        annualInterestRate: "0.03",
        disbursementDate: "2020-01-01",
        firstPaymentDate: "2020-02-01",
        id: "existing_plan",
        initialCapitalMinor: 150_000_00,
        liabilityId: "mortgage",
        termMonths: 240,
      },
      { today: TODAY },
    );

    const url = await runAction(
      form({
        id: "mortgage",
        csAnnualRate: "2,35",
        csEndDate: "2032-06-30",
        csInputMode: "rate",
        csNextPaymentDate: "2026-08-01",
        csOutstandingBalance: "118.000,00",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect((await store.liabilities.readAmortizationPlan("mortgage"))?.id).toBe(
      "existing_plan",
    );

    store.close();
  });
});

describe("saveCurrentStateAmortizationAction — original signing date (M3)", () => {
  test("rejects a future signing date BEFORE persisting anything (no orphaned plan)", async () => {
    const store = await seedAmortizableMortgage();

    const url = await runAction(
      form({
        id: "mortgage",
        csAnnualRate: "2,35",
        csEndDate: "2032-06-30",
        csInputMode: "rate",
        csNextPaymentDate: "2026-08-01",
        csOriginalSigningDate: "2026-07-03",
        csOutstandingBalance: "118.000,00",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.liabilities.readAmortizationPlan("mortgage")).toBeNull();
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);

    store.close();
  });
});

describe("saveCurrentStateAmortizationAction — housing equity nets a current-state mortgage (ADR 0013, #677)", () => {
  test("an associated property's equity nets against the declared current-state balance", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "piso",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "real_estate",
    });
    await store.liabilities.createLiability({
      associatedAssetId: "piso",
      balanceMinor: 1, // stale placeholder from whatever path created the debt
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca Santander",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "mortgage",
    });
    await store.liabilities.setDebtModel("mortgage", "amortizable");

    await runAction(
      form({
        id: "mortgage",
        csAnnualRate: "2,35",
        csEndDate: "2032-06-30",
        csInputMode: "rate",
        csNextPaymentDate: "2026-08-01",
        csOutstandingBalance: "120.000,00",
      }),
      store,
      CLOCK,
    );

    const workspace = (await store.workspace.readWorkspace())!;
    const [assets, liabilities] = await Promise.all([
      store.assets.readAssets(),
      store.liabilities.readLiabilities(),
    ]);
    const netWorth = calculateNetWorth({
      assets,
      liabilities,
      scopeId: "household",
      workspace,
    });

    // Piso 200k − hipoteca por-estado-actual 120k = 80k de equity de vivienda.
    expect(netWorth.housingEquity.amountMinor).toBe(80_000_00);

    store.close();
  });
});
