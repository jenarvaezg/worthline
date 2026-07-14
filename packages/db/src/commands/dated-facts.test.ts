/**
 * Dated-fact persist-and-ripple seams (issue #489): unit tests for the 25
 * intent-level commands whose implementation lives in `./dated-facts`. Behavioral,
 * through the public store (`createInMemoryStore` → seed → seam call → snapshot
 * reads), mirroring the established src-local store-test style of
 * `connected-source-seams.test.ts` / `snapshot-orchestrator.test.ts`. These guard
 * that the factory wiring (substituted asset/liability/operations/snapshot store
 * handles + `ctx.getWorkspace`) preserves each seam's behavior across one path per
 * category; the deeper edge matrix lives in the `tests/*.persistence.test.ts`
 * integration suites.
 */

import type { WorthlineStore } from "@db/index";
import { createInMemoryStore } from "@db/index";
import { describe, expect, it } from "vitest";

const TODAY = "2026-06-15";
const MEMBER_ID = "mJ";

async function grossAt(
  store: WorthlineStore,
  dateKey: string,
  scopeId?: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots(scopeId)).find(
    (snap) => snap.dateKey === dateKey,
  )?.grossAssets.amountMinor;
}

async function debtsAt(
  store: WorthlineStore,
  dateKey: string,
  scopeId?: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots(scopeId)).find(
    (snap) => snap.dateKey === dateKey,
  )?.debts.amountMinor;
}

describe("recordOperationAndRipple — operation dated fact (ADR 0020)", () => {
  it("a backdated buy generates a snapshot at its date carrying the fund's cost basis", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: MEMBER_ID, name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      name: "Fondo indexado",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    });

    // No snapshot exists at 2024-03-01 yet; the seam must generate it.
    expect(await grossAt(store, "2024-03-01")).toBeUndefined();

    await store.command.recordInvestmentOperation(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2024-03-01",
        feesMinor: 0,
        id: "op1",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    // 10 units × 100.00 cost basis = 1000.00 frozen at the operation date.
    expect(await grossAt(store, "2024-03-01")).toBe(10 * 100_00);
    store.close();
  });
});

describe("addValuationAnchorAndRipple — housing valuation dated fact (ADR 0020)", () => {
  it("a past appraisal anchor ripples the home value into history at its date", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: MEMBER_ID, name: "Jose" }],
      mode: "individual",
    });
    // A home created at acquisition, then a later past appraisal raises its value.
    await store.command.createHousingHolding(
      {
        asset: {
          currency: "EUR",
          currentValueMinor: 200_000_00,
          id: "home",
          liquidityTier: "illiquid",
          name: "Piso",
          ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
          type: "real_estate",
        },
        acquisitionAnchor: {
          adjustsPriorCurve: true,
          assetId: "home",
          id: "anc0",
          valuationDate: "2024-01-01",
          valueMinor: 200_000_00,
        },
        annualAppreciationRate: null,
      },
      { today: TODAY },
    );

    // The acquisition anchor backfilled a snapshot at 200_000.00.
    expect(await grossAt(store, "2024-01-01")).toBe(200_000_00);

    await store.command.addValuationAnchor(
      {
        adjustsPriorCurve: true,
        assetId: "home",
        id: "anc1",
        valuationDate: "2025-01-01",
        valueMinor: 250_000_00,
      },
      { today: TODAY },
    );

    // The new appraisal generates a snapshot at its date with the appraised value.
    expect(await grossAt(store, "2025-01-01")).toBe(250_000_00);
    store.close();
  });
});

describe("addBalanceAnchorAndRipple — debt dated fact (ADR 0020)", () => {
  it("a past balance anchor generates a snapshot carrying the anchored debt", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: MEMBER_ID, name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      type: "cash",
    });
    await store.liabilities.createLiability({
      balanceMinor: 1_000_00,
      currency: "EUR",
      id: "card",
      name: "Tarjeta",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      type: "debt",
    });
    await store.liabilities.setDebtModel("card", "revolving");

    await store.command.addBalanceAnchor(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 3_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );

    // The anchor backfilled a snapshot at its date carrying the 3000.00 balance.
    expect(await debtsAt(store, "2025-01-01")).toBe(3_000_00);
    store.close();
  });
});

describe("updateLiabilityAndRippleOwnership — ownership scope-axis seam (ADR 0020)", () => {
  it("re-weights every per-member snapshot when the split changes; household unchanged", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
      ],
      mode: "household",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 20_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [
        { memberId: "mJ", shareBps: 5_000 },
        { memberId: "mA", shareBps: 5_000 },
      ],
      type: "cash",
    });
    await store.liabilities.createLiability({
      balanceMinor: 10_000_00,
      currency: "EUR",
      id: "card",
      name: "Tarjeta",
      ownership: [
        { memberId: "mJ", shareBps: 5_000 },
        { memberId: "mA", shareBps: 5_000 },
      ],
      type: "debt",
    });
    await store.liabilities.setDebtModel("card", "revolving");
    // A past anchor backfills the household + per-member snapshots at 50/50.
    await store.command.addBalanceAnchor(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 10_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    expect(await debtsAt(store, "2025-01-01", "household")).toBe(10_000_00);
    expect(await debtsAt(store, "2025-01-01", "mJ")).toBe(5_000_00);
    expect(await debtsAt(store, "2025-01-01", "mA")).toBe(5_000_00);

    const datesBefore = (await store.snapshots.readSnapshots("mJ")).length;

    // One atomic call: persist the 50/50 → 70/30 split and ripple the scope axis.
    await store.command.updateLiabilityOwnership(
      "card",
      {
        ownership: [
          { memberId: "mJ", shareBps: 7_000 },
          { memberId: "mA", shareBps: 3_000 },
        ],
      },
      { today: TODAY },
    );

    // The household figure is unchanged; the members are re-weighted to 70/30.
    expect(await debtsAt(store, "2025-01-01", "household")).toBe(10_000_00);
    expect(await debtsAt(store, "2025-01-01", "mJ")).toBe(7_000_00);
    expect(await debtsAt(store, "2025-01-01", "mA")).toBe(3_000_00);
    // An ownership edit creates no new snapshot dates (scope axis only).
    expect((await store.snapshots.readSnapshots("mJ")).length).toBe(datesBefore);
    store.close();
  });
});
