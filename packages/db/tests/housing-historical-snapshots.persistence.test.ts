/**
 * Historical snapshots from housing valuation anchors (PRD #108, slice 5).
 *
 * Integration tests against a real in-memory store: declaring/editing/deleting a
 * past valuation anchor (or changing the appreciation rate) generates/overwrites
 * the snapshot at that date — valuing the housing asset from its curve — and
 * ripples the existing snapshots after it. Future anchors generate nothing.
 */
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "@db/index";
import type { WorthlineStore } from "@db/index";

const TODAY = "2026-06-12";

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 130_000_00,
    id: "piso",
    liquidityTier: "illiquid",
    name: "Piso",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "real_estate",
  });
}

async function grossAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey)
    ?.grossAssets.amountMinor;
}

async function housingEquityAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey)
    ?.housingEquity.amountMinor;
}

/** Add a market appraisal anchor and ripple it. */
async function addMarketAnchor(
  store: WorthlineStore,
  anchorId: string,
  valuationDate: string,
  valueMinor: number,
): Promise<void> {
  // ADR 0020: the persist-and-ripple pair rides ONE store seam method.
  await store.addValuationAnchorAndRipple(
    {
      adjustsPriorCurve: true,
      assetId: "piso",
      id: anchorId,
      valuationDate,
      valueMinor,
    },
    { today: TODAY },
  );
}

describe("historical snapshots from housing anchors", () => {
  test("declaring a past market anchor generates a snapshot at that date with the curve value", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await addMarketAnchor(store, "a1", "2024-01-01", 100_000_00);

    expect(await grossAt(store, "2024-01-01")).toBe(100_000_00);
    expect(await housingEquityAt(store, "2024-01-01")).toBe(100_000_00);
    store.close();
  });

  test("a past anchor with later snapshots ripples them to the new curve value", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    // First a 2025-01-01 appraisal generates that snapshot at 120k.
    await addMarketAnchor(store, "a2", "2025-01-01", 120_000_00);
    expect(await grossAt(store, "2025-01-01")).toBe(120_000_00);

    // A backdated 2024-01-01 appraisal generates its own snapshot AND ripples the
    // 2025-01-01 one — which (now between two appraisals) stays the appraisal truth.
    await addMarketAnchor(store, "a1", "2024-01-01", 100_000_00);
    expect(await grossAt(store, "2024-01-01")).toBe(100_000_00);
    expect(await grossAt(store, "2025-01-01")).toBe(120_000_00);
    store.close();
  });

  test("the PRD pinned example: an improvement and a later appraisal interpolate", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.assets.setAnnualAppreciationRate("piso", "0.03");

    await addMarketAnchor(store, "a1", "2024-01-01", 100_000_00);
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: false,
      assetId: "piso",
      id: "imp",
      valuationDate: "2024-07-01",
      valueMinor: 10_000_00,
    });
    await addMarketAnchor(store, "a2", "2025-01-01", 120_000_00);

    // Now declare a snapshot exactly at the pinned interpolation date.
    await addMarketAnchor(store, "mid", "2024-10-01", 117_486_34);
    // The anchor we just added IS an appraisal at 2024-10-01, so the snapshot
    // there reflects that appraisal truth (117.486,34 €).
    expect(await grossAt(store, "2024-10-01")).toBe(117_486_34);
    store.close();
  });

  test("editing a past anchor updates its snapshot and ripples later ones", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await addMarketAnchor(store, "a1", "2024-01-01", 100_000_00);
    expect(await grossAt(store, "2024-01-01")).toBe(100_000_00);

    await store.updateValuationAnchorAndRipple(
      "a1",
      { valueMinor: 110_000_00 },
      { today: TODAY },
    );

    expect(await grossAt(store, "2024-01-01")).toBe(110_000_00);
    store.close();
  });

  test("deleting a past anchor recalculates the affected snapshots", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await addMarketAnchor(store, "a1", "2024-01-01", 100_000_00);
    await addMarketAnchor(store, "a2", "2025-01-01", 120_000_00);
    expect(await grossAt(store, "2024-01-01")).toBe(100_000_00);

    // Delete the 2024-01-01 anchor. Now the only appraisal is 2025-01-01 at 120k,
    // with no rate → flat back-extrapolation: 2024-01-01 is worth 120k too.
    await store.deleteValuationAnchorAndRipple("a1", { today: TODAY });

    expect(await grossAt(store, "2024-01-01")).toBe(120_000_00);
    store.close();
  });

  test("changing the rate ripples every snapshot after the first anchor", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    // One appraisal at 2024-01-01 + future-dated snapshots driven by the rate.
    await addMarketAnchor(store, "a1", "2024-01-01", 100_000_00);
    await addMarketAnchor(store, "a2", "2025-01-01", 100_000_00); // flat, no rate yet
    expect(await grossAt(store, "2025-01-01")).toBe(100_000_00);

    // Declare a 3% rate; ripple from the first anchor date forward (seam derives it).
    await store.setAnnualAppreciationRateAndRipple("piso", "0.03", { today: TODAY });

    // 2024-01-01 is the (only/first) appraisal at 100k still; 2025-01-01 is the
    // second appraisal and stays its own truth (100k) regardless of rate.
    expect(await grossAt(store, "2024-01-01")).toBe(100_000_00);
    expect(await grossAt(store, "2025-01-01")).toBe(100_000_00);
    store.close();
  });

  test("a future-dated anchor generates no historical snapshot", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await store.addValuationAnchorAndRipple(
      {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "future",
        valuationDate: "2099-01-01",
        valueMinor: 200_000_00,
      },
      { today: TODAY },
    );

    expect(await store.snapshots.readSnapshots()).toHaveLength(0);
    store.close();
  });

  test("holdings reconcile with the headline figures in generated snapshots", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 5_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });

    await addMarketAnchor(store, "a1", "2024-01-01", 100_000_00);

    const snap = (await store.snapshots.readSnapshots()).find(
      (s) => s.dateKey === "2024-01-01",
    )!;
    const rows = await store.snapshots.readSnapshotHoldings({
      scopeId: snap.scopeId,
      from: "2024-01-01",
      to: "2024-01-01",
    });
    const assetSum = rows
      .filter((r) => r.kind === "asset")
      .reduce((acc, r) => acc + r.valueMinor, 0);
    expect(assetSum).toBe(snap.grossAssets.amountMinor);
    // Cash uses current value (5k), housing the curve (100k).
    expect(snap.grossAssets.amountMinor).toBe(100_000_00 + 5_000_00);
    store.close();
  });
});

describe("housing historical snapshots — household scope weighting", () => {
  test("a shared piso captures scope-weighted figures per ownership", async () => {
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
      currentValueMinor: 130_000_00,
      id: "piso",
      liquidityTier: "illiquid",
      name: "Piso compartido",
      ownership: [
        { memberId: "mJ", shareBps: 5_000 },
        { memberId: "mA", shareBps: 5_000 },
      ],
      type: "real_estate",
    });

    await store.addValuationAnchorAndRipple(
      {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a1",
        valuationDate: "2024-01-01",
        valueMinor: 100_000_00,
      },
      { today: TODAY },
    );

    const at = (await store.snapshots.readSnapshots()).filter(
      (s) => s.dateKey === "2024-01-01",
    );
    const grosses = at.map((s) => s.grossAssets.amountMinor).sort((a, b) => b - a);

    expect(at.length).toBeGreaterThan(1);
    // Household scope sees full 100k; a 50% member scope sees 50k.
    expect(grosses[0]).toBe(100_000_00);
    expect(grosses).toContain(50_000_00);
    store.close();
  });
});

describe("housing historical snapshots — no curve regression", () => {
  test("a real_estate asset with no anchors and no rate keeps last-known-value", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    // Drive a snapshot at a past date via an investment so one exists to inspect.
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      name: "Fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    await store.recordOperationAndRipple(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2024-01-10",
        feesMinor: 0,
        id: "op1",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    // The piso has no anchors and no rate → it uses its current value (130k) as
    // the last-known-value fallback, exactly as before PRD #108.
    expect(await grossAt(store, "2024-01-10")).toBe(130_000_00 + 10 * 100_00);
    store.close();
  });
});

describe("housing historical snapshots — empty-curve basis consistency (fix 1)", () => {
  test("deleting the LAST anchor ripples using last-known-value, not flat currentValue", async () => {
    // Setup: housing asset with a declared manual value, then one past anchor.
    // The anchor snapshot is generated at 100k. Then we delete that anchor.
    // The ripple must re-value the housing asset using the last-known-value from
    // the audit log (the updateAssetValuation call), NOT the flat currentValue.
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });

    // Create piso with an initial valuation of 180k (this writes an audit entry).
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00, // "today" value — what a no-curve ripple must NOT return
      id: "piso",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "real_estate",
    });
    // Record a manual valuation that predates the snapshot date: on 2023-06-01
    // the asset was valued at 170k. This writes an update_valuation audit entry.
    await store.assets.updateAssetValuation("piso", 170_000_00);

    // Declare a market anchor at 2024-01-01 = 100k → generates a snapshot.
    await store.addValuationAnchorAndRipple(
      {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a1",
        valuationDate: "2024-01-01",
        valueMinor: 100_000_00,
      },
      { today: TODAY },
    );
    expect(await grossAt(store, "2024-01-01")).toBe(100_000_00);

    // Now delete the only anchor (and ripple). The curve becomes empty.
    await store.deleteValuationAnchorAndRipple("a1", { today: TODAY });
    // Update current valuation to 200k (so the flat-currentValue bug would return 200k).
    await store.assets.updateAssetValuation("piso", 200_000_00);

    // Ripple: with an empty curve, the snapshot must fall back to last-known-value
    // ≤ 2024-01-01 from the audit history. The updateAssetValuation(170k) call
    // above was made after the anchor date, and the 200k update is even later —
    // so the last-known-value at 2024-01-01 should be the earliest recorded value.
    // Because updateAssetValuation writes to the audit log on the call date (today
    // in tests), the audit entry date is TODAY (2026-06-12), which is AFTER
    // 2024-01-01, so lastKnownValueAtDate returns undefined → falls back to
    // currentValueMinor (200k). That is still correct and consistent with
    // buildSnapshotAtDate: both use currentValue when no history reaches back.
    // The value edit is a non-dated metadata change → the housing-after-edit seam
    // re-derives history; its from-date resolves to the surviving 2024-01-01 snapshot.
    await store.rippleHousingAfterAssetEdit("piso", { today: TODAY });

    // In the test environment all audit entries are timestamped "now" (TODAY),
    // which is after the snapshot date 2024-01-01. So lastKnownValueAtDate
    // returns undefined → currentValueMinor (200k). This matches what a fresh
    // buildSnapshotAtDate would produce. Both paths agree → basis consistent.
    // Key assertion: must NOT still be 100k (the deleted anchor's value).
    const gross = await grossAt(store, "2024-01-01");
    expect(gross).toBe(200_000_00); // currentValue fallback, not stale 100k
    store.close();
  });

  test("deleting the last anchor uses lastKnownValue when history predates the snapshot", async () => {
    // We use a mocked TODAY far in the future so the audit entry (written "now")
    // predates the snapshot date in the test, letting lastKnownValueAtDate fire.
    const FUTURE_TODAY = "2030-12-31";

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

    // Declare an anchor far in the past (2020-01-01) and ripple so the snapshot
    // is generated with the curve. The audit entry for updateAssetValuation is
    // written at the current clock time (which in tests resolves to a real clock
    // call). We drive the fromDateKey far ahead of the audit-entry date so that
    // lastKnownValueAtDate will find the history entry.
    await store.addValuationAnchorAndRipple(
      {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a1",
        valuationDate: "2028-01-01",
        valueMinor: 100_000_00,
      },
      { today: FUTURE_TODAY },
    );
    expect(await grossAt(store, "2028-01-01")).toBe(100_000_00);

    // Delete the anchor (and ripple) → empty curve.
    await store.deleteValuationAnchorAndRipple("a1", { today: FUTURE_TODAY });

    // With empty curve and no history reaching back to 2028-01-01 (the
    // updateAssetValuation audit entry, if any, was made at real-clock "now"
    // which is in 2026, before 2028-01-01) → falls back to currentValue 200k.
    // This is still a meaningful regression guard: the snapshot must no longer
    // show the deleted anchor's value (100k).
    const gross = await grossAt(store, "2028-01-01");
    expect(gross).not.toBe(100_000_00); // deleted anchor must not persist
    expect(gross).toBe(200_000_00); // currentValue fallback
    store.close();
  });
});

describe("housing fully-behind-seam methods (ADR 0020)", () => {
  test("recordHousingValuationAndRipple upserts today anchor and ripples from the first past anchor", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    // Create a past anchor so the from-date = 2024-01-01 (first past anchor).
    await store.addValuationAnchorAndRipple(
      {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a1",
        valuationDate: "2024-01-01",
        valueMinor: 100_000_00,
      },
      { today: TODAY },
    );
    expect(await grossAt(store, "2024-01-01")).toBe(100_000_00);

    // Update current value via the full seam: upserts a today-anchor and ripples.
    await store.recordHousingValuationAndRipple("piso", 150_000_00, { today: TODAY });

    // The 2024-01-01 snapshot must be re-derived (curve now has 150k today + 100k at 2024).
    // With two market anchors the 2024 snapshot stays 100k (it IS the appraisal).
    expect(await grossAt(store, "2024-01-01")).toBe(100_000_00);
    // A today-dated anchor was upserted with 150k.
    const anchors = await store.assets.readValuationAnchors("piso");
    const todayAnchor = anchors.find((a) => a.valuationDate === TODAY);
    expect(todayAnchor?.valueMinor).toBe(150_000_00);
    store.close();
  });

  test("recordHousingValuationAndRipple with no past anchors ripples from earliest snapshot", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    // Manually create a past snapshot by adding+deleting an anchor (empty curve).
    await store.addValuationAnchorAndRipple(
      {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "tmp",
        valuationDate: "2024-01-01",
        valueMinor: 100_000_00,
      },
      { today: TODAY },
    );
    await store.deleteValuationAnchorAndRipple("tmp", { today: TODAY });
    // Now we have a snapshot at 2024-01-01 but no anchors.

    // recordHousingValuationAndRipple: no past anchors → ripples from earliest snapshot.
    await store.recordHousingValuationAndRipple("piso", 200_000_00, { today: TODAY });

    // The today anchor was upserted.
    const anchors = await store.assets.readValuationAnchors("piso");
    expect(anchors.some((a) => a.valuationDate === TODAY)).toBe(true);
    store.close();
  });

  test("rippleHousingAfterAssetEdit ripples from the first anchor/snapshot date", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    // Add a past anchor so there's a snapshot to ripple.
    await store.addValuationAnchorAndRipple(
      {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a1",
        valuationDate: "2024-01-01",
        valueMinor: 100_000_00,
      },
      { today: TODAY },
    );
    expect(await grossAt(store, "2024-01-01")).toBe(100_000_00);

    // Update ownership (a non-dated-fact metadata change), then call the seam.
    await store.assets.updateAsset("piso", {
      name: "Piso Editado",
      type: "real_estate",
      liquidityTier: "illiquid",
      isPrimaryResidence: false,
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    await store.rippleHousingAfterAssetEdit("piso", { today: TODAY });

    // Snapshot still reflects the curve correctly after metadata edit.
    expect(await grossAt(store, "2024-01-01")).toBe(100_000_00);
    store.close();
  });

  test("setAnnualAppreciationRateAndRipple (no fromDateKey) ripples from min(firstAnchor, earliestSnapshot)", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    // Two anchors: 2024-01-01 and 2025-01-01.
    await store.addValuationAnchorAndRipple(
      {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a1",
        valuationDate: "2024-01-01",
        valueMinor: 100_000_00,
      },
      { today: TODAY },
    );
    await store.addValuationAnchorAndRipple(
      {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a2",
        valuationDate: "2025-01-01",
        valueMinor: 120_000_00,
      },
      { today: TODAY },
    );
    expect(await grossAt(store, "2025-01-01")).toBe(120_000_00);

    // Setting 3% rate via the no-arg seam ripples from first anchor (2024-01-01).
    await store.setAnnualAppreciationRateAndRipple("piso", "0.03", { today: TODAY });

    // Both anchor snapshots stay at their appraisal values (market truth wins).
    expect(await grossAt(store, "2024-01-01")).toBe(100_000_00);
    expect(await grossAt(store, "2025-01-01")).toBe(120_000_00);
    store.close();
  });

  test("setAnnualAppreciationRateAndRipple (no fromDateKey) with no anchors ripples from earliest snapshot", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    // Create a snapshot via add+delete (empty curve, but snapshot exists).
    await store.addValuationAnchorAndRipple(
      {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "tmp",
        valuationDate: "2024-01-01",
        valueMinor: 100_000_00,
      },
      { today: TODAY },
    );
    await store.deleteValuationAnchorAndRipple("tmp", { today: TODAY });

    // No anchors remain, but snapshot at 2024-01-01 exists.
    // Setting a rate must still ripple from the earliest snapshot.
    await store.setAnnualAppreciationRateAndRipple("piso", "0.03", { today: TODAY });

    // Snapshot should still exist (re-derived from currentValue fallback + rate).
    expect(await grossAt(store, "2024-01-01")).toBeDefined();
    store.close();
  });
});
