/**
 * #242 — FROZEN vs LIVE identity in newly-appearing snapshot rows.
 *
 * ADR 0008: a snapshot captures the valued portfolio FROZEN. The #180–#187 audit
 * froze housing classification (`countsAsHousing`) and liquidity tier on EXISTING
 * snapshot_holdings rows and re-derives the five figures from those frozen rows.
 *
 * Suspected residual: when a holding NEWLY APPEARS in a snapshot during a ripple
 * (no `existingRow` for it on that date/scope), the recalc reads tier/housing from
 * the holding's LIVE identity instead of the frozen/contemporaneous value the
 * holding carries in its OTHER snapshot rows. Suspect sites in
 * packages/domain/src/historical-snapshot.ts:
 *   - recalculateSnapshotForAsset      line 576: `?? tierOfAsset(input.asset)`
 *   - recalculateSnapshotForHousing    line 682: same
 *   - recalculateSnapshotForOwnership  line 983: `isHousingAsset(holding.asset)`
 *   - recalculateSnapshotForCoinAcquisition line 1089: same tier `?? tierOfAsset`
 *
 * These are INTEGRATION tests against the real in-memory store, exercising the true
 * product path: an action edits a holding's instrument/tier/type, then a dated fact
 * (a backdated operation, or an ownership re-weight) ripples and GENERATES a new row
 * at a date/scope that had none. They encode the #242 acceptance criteria — some are
 * EXPECTED to FAIL until production is fixed (this is an investigation via tests).
 */
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "@db/index";
import type { WorthlineStore } from "@db/index";

const TODAY = "2026-06-16";

/** The frozen holding row for one asset on one scope/date, or undefined. */
function rowFor(
  store: WorthlineStore,
  scopeId: string,
  dateKey: string,
  holdingId: string,
) {
  return store.snapshots
    .readSnapshotHoldings({
      from: dateKey,
      holdingId,
      kind: "asset",
      scopeId,
      to: dateKey,
    })
    .find((r) => r.dateKey === dateKey);
}

function grossAt(
  store: WorthlineStore,
  scopeId: string,
  dateKey: string,
): number | undefined {
  return store.snapshots.readSnapshots(scopeId).find((s) => s.dateKey === dateKey)
    ?.grossAssets.amountMinor;
}

describe("#242 frozen-vs-live identity on newly-appearing snapshot rows", () => {
  // ── Test 1 — editing instrument/type does not silently revalue past snapshots ──
  //
  // Value is frozen-input-derived (operations + captured price), so a pure metadata
  // edit (here: tier) must NOT change a past snapshot's VALUE. Per the investigation
  // this should PASS — we confirm it.
  test("editing a holding's instrument/type does not silently revalue past snapshots", () => {
    const store = createInMemoryStore();
    store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name: "Fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });

    // A backdated buy generates the 2025-01-01 snapshot at 10 units × 100 = 1000.00.
    store.recordOperationAndRipple(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2025-01-01",
        id: "op1",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );
    const valueBefore = grossAt(store, "household", "2025-01-01");
    expect(valueBefore).toBe(1000_00);

    // A pure metadata edit: reclassify the live tier. No dated fact, no value-bearing
    // fact changed. The edit path itself ripples nothing, so the past snapshot's value
    // must be byte-identical afterwards.
    store.assets.updateInvestmentAsset({
      id: "fund",
      liquidityTier: "cash",
      manualPricePerUnit: "100",
      name: "Fondo",
    });

    expect(grossAt(store, "household", "2025-01-01")).toBe(valueBefore);
    store.close();
  });

  // ── Test 2 — a NEWLY-appearing asset row keeps its frozen/contemporaneous tier ──
  //
  // Realistic trigger: an investment held at tier "market" has snapshot rows frozen at
  // "market". A SEPARATE asset (housing anchor) owns an EARLIER snapshot date that does
  // NOT carry a row for the investment. We reclassify the investment's live tier to
  // "cash", then add a BACKDATED buy dated on that earlier date — forcing the ripple to
  // GENERATE A NEW row for the investment there. That new row must freeze the
  // CONTEMPORANEOUS tier the investment's other rows carry ("market"), not the live
  // ("cash") tier. Per the investigation this likely FAILS — line 576 freezes the live
  // tier via `tierOfAsset(input.asset)`.
  test("a holding that newly appears in a past snapshot during ripple keeps its frozen liquidity tier, not its live tier", () => {
    const store = createInMemoryStore();
    store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    // A housing asset whose anchors create the EARLY snapshot date (no fund row there).
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 130_000_00,
      id: "piso",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "real_estate",
    });
    // The investment we reclassify, held at "market".
    store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name: "Fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });

    // EARLY date carries the piso only (a housing anchor at 2024-01-01).
    store.addValuationAnchorAndRipple(
      {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "anchor1",
        valuationDate: "2024-01-01",
        valueMinor: 100_000_00,
      },
      { today: TODAY },
    );
    // LATER date carries the fund — a backdated buy at 2025-01-01 generates that
    // snapshot and freezes the fund row at the live tier of the moment: "market".
    store.recordOperationAndRipple(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2025-01-01",
        id: "op_later",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    // Sanity: the contemporaneous (frozen) tier the fund carries elsewhere is "market",
    // and the EARLY snapshot does NOT carry the fund yet.
    expect(rowFor(store, "household", "2025-01-01", "fund")?.liquidityTier).toBe(
      "market",
    );
    expect(rowFor(store, "household", "2024-01-01", "fund")).toBeUndefined();

    // The edit path reclassifies the LIVE tier to "cash" (ripples nothing on its own).
    store.assets.updateInvestmentAsset({
      id: "fund",
      liquidityTier: "cash",
      manualPricePerUnit: "100",
      name: "Fondo",
    });

    // The dated fact that GENERATES the new row: a backdated buy on the EARLY date,
    // earlier than the earliest snapshot that currently carries a fund row.
    store.recordOperationAndRipple(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2024-01-01",
        id: "op_backdated",
        kind: "buy",
        pricePerUnit: "100",
        units: "5",
      },
      { today: TODAY },
    );

    // The newly-generated fund row at the EARLY date must carry the FROZEN /
    // contemporaneous tier ("market") that the fund's other rows carry — NOT the
    // live reclassified tier ("cash"). (Per #242 this is the suspected leak: the new
    // row freezes `tierOfAsset(liveAsset)` = "cash".)
    const newRow = rowFor(store, "household", "2024-01-01", "fund");
    expect(newRow).toBeDefined();
    expect(newRow?.liquidityTier).toBe("market");

    store.close();
  });

  // ── Test 3 — a NEWLY-appearing asset row keeps its frozen countsAsHousing ──
  //
  // An asset that WAS housing at capture (countsAsHousing=true frozen) is reclassified
  // to a non-housing type AND re-weighted to give a member who previously held 0% of it
  // a stake — in the SAME ownership edit. The ownership ripple GENERATES a new row for
  // that asset in the member's scope (it had none, since the old split gave the member
  // 0%). That new row must freeze the CONTEMPORANEOUS countsAsHousing=true the asset's
  // household/other-scope rows carry — NOT the live (reclassified, false) value. Per the
  // investigation this likely FAILS — line 983 freezes `isHousingAsset(liveAsset)`.
  test("a reclassified asset that newly appears in a scope snapshot during an ownership ripple keeps its frozen countsAsHousing", () => {
    const store = createInMemoryStore();
    store.workspace.initializeWorkspace({
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
      ],
      mode: "household",
    });
    // A second home Jose owns 100% (Ana 0%) — a HOUSING asset at capture.
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "casa2",
      liquidityTier: "illiquid",
      name: "Segunda vivienda",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "real_estate",
    });
    // Ana also holds cash, so Ana's scope snapshot EXISTS at the anchor date even
    // though she holds 0% of casa2 there (her snapshot carries no casa2 row).
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash_ana",
      liquidityTier: "cash",
      name: "Cuenta Ana",
      ownership: [{ memberId: "mA", shareBps: 10_000 }],
      type: "cash",
    });

    // A past housing anchor on casa2 generates the 2024-01-01 snapshot for household +
    // Jose; Ana's scope snapshot at that date is generated by her cash, carrying no
    // casa2 row. casa2 is frozen countsAsHousing=true wherever it appears.
    store.addValuationAnchorAndRipple(
      {
        adjustsPriorCurve: true,
        assetId: "casa2",
        id: "anchor_casa2",
        valuationDate: "2024-01-01",
        valueMinor: 200_000_00,
      },
      { today: TODAY },
    );
    // Generate Ana's scope snapshot at the SAME early date via a dated fact she owns
    // 100% (a backdated buy of her own fund). This gives Ana's 2024-01-01 snapshot a
    // row — so the snapshot exists — while still carrying NO casa2 row (she held 0%
    // of casa2 then). That is the precondition for the ownership ripple to GENERATE a
    // brand-new casa2 row in her scope once she gains a stake.
    store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund_ana",
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name: "Fondo Ana",
      ownership: [{ memberId: "mA", shareBps: 10_000 }],
    });
    store.recordOperationAndRipple(
      {
        assetId: "fund_ana",
        currency: "EUR",
        executedAt: "2024-01-01",
        id: "op_ana",
        kind: "buy",
        pricePerUnit: "100",
        units: "1",
      },
      { today: TODAY },
    );

    // Sanity: casa2 is frozen countsAsHousing=true in the household scope, and Ana's
    // scope has NO casa2 row at this date (she held 0% then).
    expect(rowFor(store, "household", "2024-01-01", "casa2")?.countsAsHousing).toBe(true);
    expect(rowFor(store, "mA", "2024-01-01", "casa2")).toBeUndefined();

    // The edit: reclassify casa2 to a NON-housing type (so the ownership — not the
    // housing-curve — ripple runs) AND re-weight to give Ana a 30% stake. This fires
    // updateAssetAndRippleOwnership → the ownership ripple GENERATES a casa2 row in
    // Ana's scope (she now has a stake), freezing housing-ness from the LIVE asset.
    store.updateAssetAndRippleOwnership(
      "casa2",
      {
        ownership: [
          { memberId: "mJ", shareBps: 7_000 },
          { memberId: "mA", shareBps: 3_000 },
        ],
        type: "manual",
      },
      { today: TODAY },
    );

    // The newly-generated casa2 row in Ana's scope must carry the FROZEN
    // countsAsHousing=true the household row carries — NOT the live reclassified
    // value (false). (Per #242 this is the suspected leak at line 983.)
    const anaRow = rowFor(store, "mA", "2024-01-01", "casa2");
    expect(anaRow).toBeDefined();
    expect(anaRow?.countsAsHousing).toBe(true);

    store.close();
  });
});
