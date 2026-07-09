/**
 * Balance anchors for revolving/informal liabilities + the unified
 * debt-balance-at-date read (PRD #109, slice 8).
 *
 * Integration tests against a real in-memory store: CRUD of balance anchors and
 * the debtBalanceAtDate method that reads the debt model + anchors (+ plan /
 * revisions when amortizable) + current balance and delegates to the pure domain
 * dispatcher.
 */

import type { WorthlineStore } from "@db/index";

import { createInMemoryStore } from "@db/index";
import { describe, expect, test } from "vitest";

async function seed(store: WorthlineStore, balanceMinor = 10_000_00): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor,
    currency: "EUR",
    id: "card",
    name: "Tarjeta",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "debt",
  });
}

describe("balance anchors — CRUD", () => {
  test("create + read anchors back, ordered ascending by date", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await store.liabilities.addBalanceAnchor({
      anchorDate: "2024-06-01",
      balanceMinor: 6_000_00,
      id: "a2",
      liabilityId: "card",
    });
    await store.liabilities.addBalanceAnchor({
      anchorDate: "2024-01-01",
      balanceMinor: 10_000_00,
      id: "a1",
      liabilityId: "card",
    });

    const anchors = await store.liabilities.readBalanceAnchors("card");
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

  test("rejects a non-integer balance", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await expect(
      store.liabilities.addBalanceAnchor({
        anchorDate: "2024-01-01",
        balanceMinor: 10_000.5,
        id: "a1",
        liabilityId: "card",
      }),
    ).rejects.toThrow(/minor units/);
  });

  test("rejects a malformed anchor date", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await expect(
      store.liabilities.addBalanceAnchor({
        anchorDate: "2024/01/01",
        balanceMinor: 10_000_00,
        id: "a1",
        liabilityId: "card",
      }),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  test("a duplicate (liability, date) collides loudly (unique index)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.liabilities.addBalanceAnchor({
      anchorDate: "2024-01-01",
      balanceMinor: 10_000_00,
      id: "a1",
      liabilityId: "card",
    });
    await expect(
      store.liabilities.addBalanceAnchor({
        anchorDate: "2024-01-01",
        balanceMinor: 9_000_00,
        id: "a2",
        liabilityId: "card",
      }),
    ).rejects.toThrow();
  });

  test("update an anchor in place", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.liabilities.addBalanceAnchor({
      anchorDate: "2024-01-01",
      balanceMinor: 10_000_00,
      id: "a1",
      liabilityId: "card",
    });

    expect(
      (
        await store.liabilities.updateBalanceAnchor("a1", {
          anchorDate: "2024-02-01",
          balanceMinor: 8_000_00,
        })
      ).changes,
    ).toBe(1);

    expect(await store.liabilities.readBalanceAnchors("card")).toEqual([
      expect.objectContaining({
        anchorDate: "2024-02-01",
        balanceMinor: 8_000_00,
        id: "a1",
      }),
    ]);
  });

  test("updating a missing anchor returns 0", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    expect(
      (await store.liabilities.updateBalanceAnchor("nope", { balanceMinor: 1 })).changes,
    ).toBe(0);
  });

  test("delete an anchor by id", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.liabilities.addBalanceAnchor({
      anchorDate: "2024-01-01",
      balanceMinor: 10_000_00,
      id: "a1",
      liabilityId: "card",
    });
    expect((await store.liabilities.deleteBalanceAnchor("a1")).changes).toBe(1);
    expect(await store.liabilities.readBalanceAnchors("card")).toEqual([]);
    expect((await store.liabilities.deleteBalanceAnchor("a1")).changes).toBe(0);
  });
});

describe("debtBalanceAtDate — unified read", () => {
  test("revolving: steps between stored anchors (ADR 0031)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.liabilities.setDebtModel("card", "revolving");
    await store.liabilities.addBalanceAnchor({
      anchorDate: "2024-01-01",
      balanceMinor: 10_000_00,
      id: "a1",
      liabilityId: "card",
    });
    await store.liabilities.addBalanceAnchor({
      anchorDate: "2024-12-31",
      balanceMinor: 0,
      id: "a2",
      liabilityId: "card",
    });

    // Default `step` cadence: a between-anchor date holds the most recent anchor
    // (2024-01-01 = 10_000_00), not the interpolated 501_370.
    expect(await store.liabilities.debtBalanceAtDate("card", "2024-07-01")).toBe(
      10_000_00,
    );
  });

  test("informal: step function on stored anchors", async () => {
    const store = await createInMemoryStore();
    await seed(store, 1_000_00);
    await store.liabilities.setDebtModel("card", "informal");
    await store.liabilities.addBalanceAnchor({
      anchorDate: "2023-01-01",
      balanceMinor: 5_000_00,
      id: "a1",
      liabilityId: "card",
    });
    await store.liabilities.addBalanceAnchor({
      anchorDate: "2023-06-01",
      balanceMinor: 3_000_00,
      id: "a2",
      liabilityId: "card",
    });

    expect(await store.liabilities.debtBalanceAtDate("card", "2023-03-15")).toBe(
      5_000_00,
    );
    expect(await store.liabilities.debtBalanceAtDate("card", "2023-09-09")).toBe(
      3_000_00,
    );
    // No anchor on/before target → falls back to the current balance.
    expect(await store.liabilities.debtBalanceAtDate("card", "2020-01-01")).toBe(
      1_000_00,
    );
  });

  test("amortizable: delegates to the stored plan", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.liabilities.setDebtModel("card", "amortizable");
    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.025",
      id: "plan1",
      initialCapitalMinor: 200_000_00,
      liabilityId: "card",
      disbursementDate: "2020-01-01",

      firstPaymentDate: "2020-02-01",
      termMonths: 360,
    });

    expect(await store.liabilities.debtBalanceAtDate("card", "2019-06-01")).toBe(
      200_000_00,
    );
    expect(await store.liabilities.debtBalanceAtDate("card", "2050-01-01")).toBe(0);
  });

  test("null debt model returns the current balance constant", async () => {
    const store = await createInMemoryStore();
    await seed(store, 4_242_42);
    expect(await store.liabilities.debtBalanceAtDate("card", "2024-07-01")).toBe(
      4_242_42,
    );
  });
});
