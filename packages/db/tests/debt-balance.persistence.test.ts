/**
 * Balance anchors for revolving/informal liabilities + the unified
 * debt-balance-at-date read (PRD #109, slice 8).
 *
 * Integration tests against a real in-memory store: CRUD of balance anchors and
 * the debtBalanceAtDate method that reads the debt model + anchors (+ plan /
 * revisions when amortizable) + current balance and delegates to the pure domain
 * dispatcher.
 */
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "../src/index";
import type { WorthlineStore } from "../src/index";

function seed(store: WorthlineStore, balanceMinor = 10_000_00): void {
  store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  store.liabilities.createLiability({
    balanceMinor,
    currency: "EUR",
    id: "card",
    name: "Tarjeta",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "debt",
  });
}

describe("balance anchors — CRUD", () => {
  test("create + read anchors back, ordered ascending by date", () => {
    const store = createInMemoryStore();
    seed(store);

    store.liabilities.addBalanceAnchor({
      anchorDate: "2024-06-01",
      balanceMinor: 6_000_00,
      id: "a2",
      liabilityId: "card",
    });
    store.liabilities.addBalanceAnchor({
      anchorDate: "2024-01-01",
      balanceMinor: 10_000_00,
      id: "a1",
      liabilityId: "card",
    });

    const anchors = store.liabilities.readBalanceAnchors("card");
    expect(anchors).toEqual([
      expect.objectContaining({
        anchorDate: "2024-01-01",
        balanceMinor: 10_000_00,
        id: "a1",
        liabilityId: "card",
      }),
      expect.objectContaining({
        anchorDate: "2024-06-01",
        balanceMinor: 6_000_00,
        id: "a2",
        liabilityId: "card",
      }),
    ]);
  });

  test("rejects a non-integer balance", () => {
    const store = createInMemoryStore();
    seed(store);
    expect(() =>
      store.liabilities.addBalanceAnchor({
        anchorDate: "2024-01-01",
        balanceMinor: 10_000.5,
        id: "a1",
        liabilityId: "card",
      }),
    ).toThrow(/minor units/);
  });

  test("rejects a malformed anchor date", () => {
    const store = createInMemoryStore();
    seed(store);
    expect(() =>
      store.liabilities.addBalanceAnchor({
        anchorDate: "2024/01/01",
        balanceMinor: 10_000_00,
        id: "a1",
        liabilityId: "card",
      }),
    ).toThrow(/YYYY-MM-DD/);
  });

  test("a duplicate (liability, date) collides loudly (unique index)", () => {
    const store = createInMemoryStore();
    seed(store);
    store.liabilities.addBalanceAnchor({
      anchorDate: "2024-01-01",
      balanceMinor: 10_000_00,
      id: "a1",
      liabilityId: "card",
    });
    expect(() =>
      store.liabilities.addBalanceAnchor({
        anchorDate: "2024-01-01",
        balanceMinor: 9_000_00,
        id: "a2",
        liabilityId: "card",
      }),
    ).toThrow();
  });

  test("update an anchor in place", () => {
    const store = createInMemoryStore();
    seed(store);
    store.liabilities.addBalanceAnchor({
      anchorDate: "2024-01-01",
      balanceMinor: 10_000_00,
      id: "a1",
      liabilityId: "card",
    });

    expect(
      store.liabilities.updateBalanceAnchor("a1", {
        anchorDate: "2024-02-01",
        balanceMinor: 8_000_00,
      }),
    ).toBe(1);

    expect(store.liabilities.readBalanceAnchors("card")).toEqual([
      expect.objectContaining({
        anchorDate: "2024-02-01",
        balanceMinor: 8_000_00,
        id: "a1",
      }),
    ]);
  });

  test("updating a missing anchor returns 0", () => {
    const store = createInMemoryStore();
    seed(store);
    expect(store.liabilities.updateBalanceAnchor("nope", { balanceMinor: 1 })).toBe(0);
  });

  test("delete an anchor by id", () => {
    const store = createInMemoryStore();
    seed(store);
    store.liabilities.addBalanceAnchor({
      anchorDate: "2024-01-01",
      balanceMinor: 10_000_00,
      id: "a1",
      liabilityId: "card",
    });
    expect(store.liabilities.deleteBalanceAnchor("a1")).toBe(1);
    expect(store.liabilities.readBalanceAnchors("card")).toEqual([]);
    expect(store.liabilities.deleteBalanceAnchor("a1")).toBe(0);
  });
});

describe("debtBalanceAtDate — unified read", () => {
  test("revolving: interpolates between stored anchors", () => {
    const store = createInMemoryStore();
    seed(store);
    store.liabilities.setDebtModel("card", "revolving");
    store.liabilities.addBalanceAnchor({
      anchorDate: "2024-01-01",
      balanceMinor: 10_000_00,
      id: "a1",
      liabilityId: "card",
    });
    store.liabilities.addBalanceAnchor({
      anchorDate: "2024-12-31",
      balanceMinor: 0,
      id: "a2",
      liabilityId: "card",
    });

    expect(store.liabilities.debtBalanceAtDate("card", "2024-07-01")).toBe(501_370);
  });

  test("informal: step function on stored anchors", () => {
    const store = createInMemoryStore();
    seed(store, 1_000_00);
    store.liabilities.setDebtModel("card", "informal");
    store.liabilities.addBalanceAnchor({
      anchorDate: "2023-01-01",
      balanceMinor: 5_000_00,
      id: "a1",
      liabilityId: "card",
    });
    store.liabilities.addBalanceAnchor({
      anchorDate: "2023-06-01",
      balanceMinor: 3_000_00,
      id: "a2",
      liabilityId: "card",
    });

    expect(store.liabilities.debtBalanceAtDate("card", "2023-03-15")).toBe(5_000_00);
    expect(store.liabilities.debtBalanceAtDate("card", "2023-09-09")).toBe(3_000_00);
    // No anchor on/before target → falls back to the current balance.
    expect(store.liabilities.debtBalanceAtDate("card", "2020-01-01")).toBe(1_000_00);
  });

  test("amortizable: delegates to the stored plan", () => {
    const store = createInMemoryStore();
    seed(store);
    store.liabilities.setDebtModel("card", "amortizable");
    store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.025",
      id: "plan1",
      initialCapitalMinor: 200_000_00,
      liabilityId: "card",
      disbursementDate: "2020-01-01",

      firstPaymentDate: "2020-02-01",
      termMonths: 360,
    });

    expect(store.liabilities.debtBalanceAtDate("card", "2019-06-01")).toBe(200_000_00);
    expect(store.liabilities.debtBalanceAtDate("card", "2050-01-01")).toBe(0);
  });

  test("null debt model returns the current balance constant", () => {
    const store = createInMemoryStore();
    seed(store, 4_242_42);
    expect(store.liabilities.debtBalanceAtDate("card", "2024-07-01")).toBe(4_242_42);
  });
});
