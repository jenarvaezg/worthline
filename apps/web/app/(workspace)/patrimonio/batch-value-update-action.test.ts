/**
 * Action-level tests for batchValueUpdateAction — the manual value-update pass
 * ("puesta al día") (#308).
 *
 * The pass hand-updates the value of every holding whose valuation method is NOT
 * derived (ADR 0014): cash/manual (`stored`) and properties (`appreciating`,
 * whose current value anchors the curve) are eligible; investments and other
 * derived-value holdings (connected-source coin collections) are computed from
 * their sub-detail and must stay excluded. These tests PIN that exact set so the
 * catalog-seam refactor (#308) — dropping the inline derived-id deny-list —
 * preserves behaviour byte-for-byte.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import { batchValueUpdateAction } from "./actions";
import { createHoldingAction } from "./create-holding-action";

/** Build a FormData with the given key/value pairs. */
function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

/** Invoke an action (which always redirect()s) and return the redirect URL/digest. */
async function runAction(
  action: (fd: FormData, store: WorthlineStore) => Promise<never>,
  fd: FormData,
  store: WorthlineStore,
): Promise<string> {
  try {
    await action(fd, store);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

async function seedStore(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

/**
 * Seed one holding of each valuation method that matters here and return its id:
 *  - a current account  → `stored`       (hand-valued, eligible)
 *  - a property         → `appreciating` (hand-valued, eligible)
 *  - a stock investment → `derived`      (computed from operations, excluded)
 */
async function seedHoldings(store: WorthlineStore): Promise<{
  storedId: string;
  appreciatingId: string;
  derivedId: string;
}> {
  await runAction(
    createHoldingAction,
    form({
      instrument: "current_account",
      name_current_account: "Cuenta BBVA",
      value_current_account: "2.500,00",
      ownershipPreset: "scope",
      scopeMemberId: "mJ",
    }),
    store,
  );
  await runAction(
    createHoldingAction,
    form({
      instrument: "property",
      name_property: "Piso Malasaña",
      acqDate_property: "2020-01-15",
      acqValue_property: "180.000,00",
      rate_property: "3",
      ownershipPreset: "scope",
      scopeMemberId: "mJ",
    }),
    store,
  );
  await runAction(
    createHoldingAction,
    form({
      instrument: "stock",
      name_stock: "Apple",
      symbol_stock: "AAPL",
      ownershipPreset: "scope",
      scopeMemberId: "mJ",
    }),
    store,
  );

  const assets = await store.assets.readAssets();
  const storedId = assets.find((a) => a.instrument === "current_account")!.id;
  const appreciatingId = assets.find((a) => a.instrument === "property")!.id;
  const derivedId = assets.find((a) => a.instrument === "stock")!.id;
  return { storedId, appreciatingId, derivedId };
}

describe("batchValueUpdateAction — who the value-update pass accepts (#308)", () => {
  test("hand-valued holdings (stored + appreciating) are updated", async () => {
    const store = await seedStore();
    const { storedId, appreciatingId } = await seedHoldings(store);

    const url = await runAction(
      batchValueUpdateAction,
      form({
        [`val_${storedId}`]: "3.000,00",
        [`val_${appreciatingId}`]: "200.000,00",
      }),
      store,
    );

    // No error redirect — the submission was accepted.
    expect(url).not.toContain("error=");
    expect(url).toContain("/patrimonio");

    const assets = await store.assets.readAssets();
    expect(assets.find((a) => a.id === storedId)!.currentValue.amountMinor).toBe(300_000);
    expect(assets.find((a) => a.id === appreciatingId)!.currentValue.amountMinor).toBe(
      20_000_000,
    );
  });

  test("a derived holding (investment) is rejected — value comes from its sub-detail", async () => {
    const store = await seedStore();
    const { derivedId } = await seedHoldings(store);

    const url = await runAction(
      batchValueUpdateAction,
      form({ [`val_${derivedId}`]: "9.999,00" }),
      store,
    );

    // The pass refuses a derived holding rather than hand-setting its value.
    expect(url).toContain("error=");
  });
});

/**
 * A debt with a modelled curve takes its figure from the curve, so its stored
 * balance is a dead field — writing it "saves" without a single figure moving
 * (#1290, here on the batch surface: #1334). The page stops offering the input;
 * this is the server half, for the tab that was open before the curve existed.
 */
describe("batchValueUpdateAction — debts with a curve (#1334)", () => {
  /** A `debt` liability with no curve data: the stored balance is all it has. */
  async function seedBareDebt(store: WorthlineStore, name: string): Promise<string> {
    await runAction(
      createHoldingAction,
      form({
        instrument: "loan",
        [`name_loan`]: name,
        [`balance_loan`]: "10.000,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );
    const liabilities = await store.liabilities.readLiabilities();
    return liabilities.find((l) => l.name === name)!.id;
  }

  test("a debt with no curve is still updated by the pass", async () => {
    const store = await seedStore();
    const debtId = await seedBareDebt(store, "Préstamo coche");

    const url = await runAction(
      batchValueUpdateAction,
      form({ [`val_${debtId}`]: "8.000,00" }),
      store,
    );

    expect(url).not.toContain("error=");
    const liability = (await store.liabilities.readLiabilities()).find(
      (l) => l.id === debtId,
    )!;
    expect(liability.currentBalance.amountMinor).toBe(800_000);
  });

  test("a declared balance retires the row — the batch is refused, nothing is written", async () => {
    const store = await seedStore();
    const { storedId } = await seedHoldings(store);
    const debtId = await seedBareDebt(store, "Tarjeta Revolut");
    await store.liabilities.setDebtModel(debtId, "revolving");
    await store.command.addBalanceAnchor({
      anchorDate: "2026-07-01",
      balanceMinor: 1_200_00,
      id: "anchor_card",
      liabilityId: debtId,
    });

    const url = await runAction(
      batchValueUpdateAction,
      form({
        [`val_${storedId}`]: "3.000,00",
        [`val_${debtId}`]: "999,00",
      }),
      store,
    );

    expect(url).toContain("error=");
    // Nothing of the batch landed — not the debt, and not the asset beside it.
    const liability = (await store.liabilities.readLiabilities()).find(
      (l) => l.id === debtId,
    )!;
    expect(liability.currentBalance.amountMinor).toBe(1_000_000);
    const asset = (await store.assets.readAssets()).find((a) => a.id === storedId)!;
    expect(asset.currentValue.amountMinor).toBe(250_000);
  });

  test("an amortizable debt with a plan is refused too", async () => {
    const store = await seedStore();
    const debtId = await seedBareDebt(store, "Hipoteca Santander");
    await store.command.createCurrentStateDebt({
      plan: {
        annualInterestRate: "0.0325",
        disbursementDate: "2026-01-01",
        firstPaymentDate: "2026-02-01",
        id: "plan_mortgage",
        initialCapitalMinor: 90_000_00,
        liabilityId: debtId,
        termMonths: 120,
      },
      rebaseline: {
        annualInterestRate: "0.0325",
        baselineDate: "2026-01-01",
        endDate: "2036-01-01",
        id: "reb_mortgage",
        liabilityId: debtId,
        nextPaymentDate: "2026-02-01",
        outstandingBalanceMinor: 90_000_00,
        startsAtBaseline: true,
      },
      today: "2026-07-31",
    });

    const url = await runAction(
      batchValueUpdateAction,
      form({ [`val_${debtId}`]: "1,00" }),
      store,
    );

    expect(url).toContain("error=");
  });
});
