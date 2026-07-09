/**
 * Historical snapshots re-weighting after an ownership-split edit (#172).
 *
 * An ownership split determines how each frozen snapshot weights a holding's
 * global value into each member's scope. Correcting it is a retroactive
 * parameter change (ADR 0012), so it must ripple: every existing per-member
 * scope snapshot is re-derived with the new weighting, the household scope (which
 * always sums to 100%) is untouched, no new snapshot dates are created, and the
 * reconciliation invariant (ADR 0008) still holds. The concrete scenario: a user
 * backdates a mortgage (which backfills monthly snapshots, PRD #109), then later
 * corrects the ownership %.
 */

import type { WorthlineStore } from "@db/index";
import { createInMemoryStore } from "@db/index";
import { allocateScopedHolding } from "@worthline/domain";
import { describe, expect, test } from "vitest";

const TODAY = "2026-06-13";
const PAST_DATES = ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15", "2026-05-15"];

/** A 2-member household with a 50/50 mortgage whose backdated plan backfills snapshots. */
async function seed(store: WorthlineStore): Promise<void> {
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
    balanceMinor: 100_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [
      { memberId: "mJ", shareBps: 5_000 },
      { memberId: "mA", shareBps: 5_000 },
    ],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", "amortizable");
  await store.createAmortizationPlanAndRipple(
    {
      annualInterestRate: "0.03",
      id: "plan1",
      initialCapitalMinor: 150_000_00,
      liabilityId: "mortgage",
      disbursementDate: "2026-01-15",

      firstPaymentDate: "2026-02-15",
      termMonths: 240,
    },
    { today: TODAY },
  );
}

async function debtsAt(
  store: WorthlineStore,
  dateKey: string,
  scopeId: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots(scopeId)).find(
    (snap) => snap.dateKey === dateKey,
  )?.debts.amountMinor;
}

async function reconciles(
  store: WorthlineStore,
  dateKey: string,
  scopeId: string,
): Promise<boolean> {
  const snap = (await store.snapshots.readSnapshots(scopeId)).find(
    (s) => s.dateKey === dateKey,
  );
  if (!snap) return false;
  const rows = await store.snapshots.readSnapshotHoldings({
    from: dateKey,
    scopeId,
    to: dateKey,
  });
  const assets = rows
    .filter((r) => r.kind === "asset")
    .reduce((s, r) => s + r.valueMinor, 0);
  const debts = rows
    .filter((r) => r.kind === "liability")
    .reduce((s, r) => s + r.valueMinor, 0);
  return assets === snap.grossAssets.amountMinor && debts === snap.debts.amountMinor;
}

function owned(globalMinor: number, shareBps: number, memberId: string): number {
  return allocateScopedHolding(globalMinor, {
    ownership: [{ memberId, shareBps }],
    scopeMemberIds: new Set([memberId]),
  }).ownedMinor;
}

describe("ownership-split ripple over historical snapshots (#172)", () => {
  test("re-weights every per-member snapshot to the new split; household unchanged; no new dates", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const datesBefore = (await store.snapshots.readSnapshots("mJ")).length;

    // Correct the mortgage split from 50/50 to 70/30 — one atomic seam call
    // persists the patch and ripples the scope axis (previous split read behind
    // the seam).
    await store.updateLiabilityAndRippleOwnership("mortgage", {
      ownership: [
        { memberId: "mJ", shareBps: 7_000 },
        { memberId: "mA", shareBps: 3_000 },
      ],
    });

    for (const dateKey of PAST_DATES) {
      const globalBalance = (await store.liabilities.debtBalanceAtDate(
        "mortgage",
        dateKey,
      ))!;
      // Household always sees the full balance — the edit does not touch it.
      expect(await debtsAt(store, dateKey, "household")).toBe(globalBalance);
      // Each member's scope is re-weighted by the new split.
      expect(await debtsAt(store, dateKey, "mJ")).toBe(owned(globalBalance, 7_000, "mJ"));
      expect(await debtsAt(store, dateKey, "mA")).toBe(owned(globalBalance, 3_000, "mA"));
      // Reconciliation holds for every scope.
      expect(await reconciles(store, dateKey, "household")).toBe(true);
      expect(await reconciles(store, dateKey, "mJ")).toBe(true);
      expect(await reconciles(store, dateKey, "mA")).toBe(true);
    }

    // No new snapshot dates were created by the ownership edit.
    expect((await store.snapshots.readSnapshots("mJ")).length).toBe(datesBefore);
    store.close();
  });

  test("re-running the ripple is idempotent (stable under repeated edits)", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await store.updateLiabilityAndRippleOwnership("mortgage", {
      ownership: [
        { memberId: "mJ", shareBps: 7_000 },
        { memberId: "mA", shareBps: 3_000 },
      ],
    });
    const first = await Promise.all(PAST_DATES.map((d) => debtsAt(store, d, "mJ")));

    // Re-applying the now-current split is a no-op: the seam sees the stored split
    // already equals the patch, so it ripples nothing (rows already 70/30).
    await store.updateLiabilityAndRippleOwnership("mortgage", {
      ownership: [
        { memberId: "mJ", shareBps: 7_000 },
        { memberId: "mA", shareBps: 3_000 },
      ],
    });
    const second = await Promise.all(PAST_DATES.map((d) => debtsAt(store, d, "mJ")));

    expect(second).toEqual(first);
    store.close();
  });
});

/**
 * The home global value (cents) chosen so the household's 65% combined share
 * `round(GLOBAL * 6_500 / 10_000)` = 19_500_001 cannot be divided back to GLOBAL:
 * `round(19_500_001 * 10_000 / 6_500)` = 30_000_002, a +1-cent drift. This is the
 * exact ±1 the lossy "divide the rounded household row" recovery introduced (#187).
 */
const HOME_GLOBAL_MINOR = 30_000_001;

/**
 * A 2-member household owning a home co-owned 65% by the household (35% a
 * non-member): household combined share 6_500 bps < 100% — the co-owned-home
 * exception in the ownership-split glossary, the ONLY case the lossy recovery
 * affected (#187). The home is pinned to a drifting global by a single valuation
 * anchor; a co-owned mortgage's amortizable plan backfills several snapshot dates
 * (PRD #109), each capturing the home at its flat curve value, so the drift
 * appears on every date. A wholly-household cash holding (100% inside the
 * household) is present to prove it stays exact and unchanged.
 */
async function seedCoOwnedHome(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [
      { id: "mJ", name: "Jose" },
      { id: "mA", name: "Ana" },
    ],
    mode: "household",
  });
  // A wholly-household holding (100% inside the household) — must stay exact.
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
  // The home, co-owned 40/25 by the members + 35% a non-member (household 65%).
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: HOME_GLOBAL_MINOR,
    id: "piso",
    liquidityTier: "illiquid",
    name: "Piso",
    ownership: [
      { memberId: "mJ", shareBps: 4_000 },
      { memberId: "mA", shareBps: 2_500 },
    ],
    type: "real_estate",
  });
  // Pin the home's global value flat at the drifting amount via one anchor.
  await store.assets.addValuationAnchor({
    adjustsPriorCurve: true,
    assetId: "piso",
    id: "anchor1",
    valuationDate: "2026-01-15",
    valueMinor: HOME_GLOBAL_MINOR,
  });
  // A co-owned mortgage whose amortizable plan backfills one snapshot per past
  // cuota (PRD #109); each captured snapshot also freezes the home's row.
  await store.liabilities.createLiability({
    balanceMinor: 200_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [
      { memberId: "mJ", shareBps: 4_000 },
      { memberId: "mA", shareBps: 2_500 },
    ],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", "amortizable");
  await store.createAmortizationPlanAndRipple(
    {
      annualInterestRate: "0.0317",
      id: "plan1",
      initialCapitalMinor: 210_000_00,
      liabilityId: "mortgage",
      disbursementDate: "2026-01-15",

      firstPaymentDate: "2026-02-15",
      termMonths: 240,
    },
    { today: TODAY },
  );
}

async function homeRowAt(
  store: WorthlineStore,
  dateKey: string,
  scopeId: string,
): Promise<number | undefined> {
  return (
    await store.snapshots.readSnapshotHoldings({ from: dateKey, scopeId, to: dateKey })
  ).find((r) => r.holdingId === "piso")?.valueMinor;
}

describe("ownership-split ripple recovers the global value losslessly for a co-owned home (#187)", () => {
  test("each member's re-weighted home row equals a from-scratch re-derivation EXACTLY (zero ±1 drift)", async () => {
    const store = await createInMemoryStore();
    await seedCoOwnedHome(store);

    // The dates the mortgage backfilled (one per past cuota), each capturing the
    // home at its flat curve value HOME_GLOBAL_MINOR.
    const dates = (await store.snapshots.readSnapshots("household")).map(
      (snap) => snap.dateKey,
    );
    expect(dates.length).toBeGreaterThan(2);

    // Correct the INTERNAL member split (40/25 → 30/35) — the household combined
    // share stays 65%, so the household row is invariant, but each member's row
    // is re-derived from the (lossless) global value under the new split. A home
    // ownership edit rides the seam, which dispatches a real_estate asset to the
    // housing curve ripple — losslessly re-deriving the home from its flat curve
    // value (HOME_GLOBAL_MINOR), never by dividing the rounded household row (#187).
    await store.updateAssetAndRippleOwnership("piso", {
      ownership: [
        { memberId: "mJ", shareBps: 3_000 },
        { memberId: "mA", shareBps: 3_500 },
      ],
    });

    for (const dateKey of dates) {
      // The lossless source of truth: the home's global value, never recovered by
      // dividing the rounded household row.
      expect(await homeRowAt(store, dateKey, "household")).toBe(
        owned(HOME_GLOBAL_MINOR, 6_500, "mJ"),
      );
      // Each member's row must match the from-scratch re-derivation EXACTLY — the
      // lossy recovery drifted these by ±1 cent (30_000_002 vs 30_000_001).
      expect(await homeRowAt(store, dateKey, "mJ")).toBe(
        owned(HOME_GLOBAL_MINOR, 3_000, "mJ"),
      );
      expect(await homeRowAt(store, dateKey, "mA")).toBe(
        owned(HOME_GLOBAL_MINOR, 3_500, "mA"),
      );
      // Reconciliation (ADR 0008) holds on every re-weighted snapshot.
      expect(await reconciles(store, dateKey, "household")).toBe(true);
      expect(await reconciles(store, dateKey, "mJ")).toBe(true);
      expect(await reconciles(store, dateKey, "mA")).toBe(true);
    }

    store.close();
  });

  test("the wholly-household holding stays byte-identical after the same ownership edit", async () => {
    const store = await createInMemoryStore();
    await seedCoOwnedHome(store);

    const dates = (await store.snapshots.readSnapshots("mJ")).map((snap) => snap.dateKey);

    const cashRow = async (
      dateKey: string,
      scopeId: string,
    ): Promise<number | undefined> =>
      (
        await store.snapshots.readSnapshotHoldings({
          from: dateKey,
          scopeId,
          to: dateKey,
        })
      ).find((r) => r.holdingId === "cash")?.valueMinor;

    const before = await Promise.all(
      dates.flatMap((d) => [cashRow(d, "household"), cashRow(d, "mJ"), cashRow(d, "mA")]),
    );

    await store.updateAssetAndRippleOwnership("piso", {
      ownership: [
        { memberId: "mJ", shareBps: 3_000 },
        { memberId: "mA", shareBps: 3_500 },
      ],
    });

    const after = await Promise.all(
      dates.flatMap((d) => [cashRow(d, "household"), cashRow(d, "mJ"), cashRow(d, "mA")]),
    );

    expect(after).toEqual(before);
    store.close();
  });
});

/**
 * A 2-member household with an investment fund whose value is recorded ONLY
 * through its operation ledger, plus a mortgage whose amortizable plan backfills
 * several snapshot dates (PRD #109). Each backfilled snapshot freezes the fund's
 * row at its captured value. The fund's single buy predates every backfilled
 * date, so the fund is held on all of them at capture time. An investment must
 * be 100% owned by the workspace members (60/40 here); deleting its operations
 * leaves the live ledger unable to value it on any date, so its re-derived global
 * is null — the #212 unrecoverable-global case.
 */
async function seedFundFrozenThenLedgerless(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [
      { id: "mJ", name: "Jose" },
      { id: "mA", name: "Ana" },
    ],
    mode: "household",
  });
  // An investment fund split 60/40 by the members. Its only source of truth is
  // the operation ledger (no manual price), so deleting its operations makes the
  // live ledger no longer hold it on any date (re-derived global is null).
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fondo",
    liquidityTier: "market",
    name: "Fondo",
    ownership: [
      { memberId: "mJ", shareBps: 6_000 },
      { memberId: "mA", shareBps: 4_000 },
    ],
  });
  await store.operations.recordOperation({
    assetId: "fondo",
    currency: "EUR",
    executedAt: "2026-01-01",
    feesMinor: 0,
    id: "opBuy",
    kind: "buy",
    pricePerUnit: "100",
    units: "10",
  });
  // A mortgage whose amortizable plan backfills one snapshot per past cuota (PRD
  // #109); each captured snapshot also freezes the fund's row.
  await store.liabilities.createLiability({
    balanceMinor: 200_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [
      { memberId: "mJ", shareBps: 6_000 },
      { memberId: "mA", shareBps: 4_000 },
    ],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", "amortizable");
  await store.createAmortizationPlanAndRipple(
    {
      annualInterestRate: "0.0317",
      id: "plan1",
      initialCapitalMinor: 210_000_00,
      liabilityId: "mortgage",
      disbursementDate: "2026-01-15",
      firstPaymentDate: "2026-02-15",
      termMonths: 240,
    },
    { today: TODAY },
  );
}

describe("ownership-split ripple leaves the frozen row untouched when the global is unrecoverable (#212)", () => {
  test("a co-owned holding whose global cannot be re-derived for a date is NOT re-weighted", async () => {
    const store = await createInMemoryStore();
    await seedFundFrozenThenLedgerless(store);

    const fundRow = async (
      dateKey: string,
      scopeId: string,
    ): Promise<number | undefined> =>
      (
        await store.snapshots.readSnapshotHoldings({
          from: dateKey,
          scopeId,
          to: dateKey,
        })
      ).find((r) => r.holdingId === "fondo")?.valueMinor;

    const dates = (await store.snapshots.readSnapshots("household")).map(
      (snap) => snap.dateKey,
    );
    expect(dates.length).toBeGreaterThan(2);
    // The fund WAS frozen into every backfilled household snapshot.
    for (const dateKey of dates) {
      expect(await fundRow(dateKey, "household")).not.toBeUndefined();
    }

    // Snapshot the frozen rows and headline figures BEFORE the edit, across all
    // scopes — these must be byte-identical after the ripple.
    const figuresOf = async (
      dateKey: string,
      scopeId: string,
    ): Promise<Record<string, number> | undefined> => {
      const snap = (await store.snapshots.readSnapshots(scopeId)).find(
        (s) => s.dateKey === dateKey,
      );
      if (!snap) return undefined;
      return {
        debts: snap.debts.amountMinor,
        grossAssets: snap.grossAssets.amountMinor,
        housingEquity: snap.housingEquity.amountMinor,
        liquidNetWorth: snap.liquidNetWorth.amountMinor,
        totalNetWorth: snap.totalNetWorth.amountMinor,
      };
    };
    const scopes = ["household", "mJ", "mA"];
    const fundBefore = await Promise.all(
      dates.flatMap((d) => scopes.map((s) => fundRow(d, s))),
    );
    const figuresBefore = await Promise.all(
      dates.flatMap((d) => scopes.map((s) => figuresOf(d, s))),
    );

    // Delete the fund's only operation: the live ledger no longer holds it on any
    // date, so its global value is unrecoverable for every frozen snapshot.
    await store.operations.deleteOperation("opBuy");

    // Correct the member split (60/40 → 70/30). With the global unrecoverable,
    // re-weighting the already-allocated row would reconstruct the frozen member
    // rows from a value the live ledger can no longer justify (#187 lossiness) —
    // the ripple must SKIP these dates and leave every frozen row untouched.
    await store.updateAssetAndRippleOwnership("fondo", {
      ownership: [
        { memberId: "mJ", shareBps: 7_000 },
        { memberId: "mA", shareBps: 3_000 },
      ],
    });

    const fundAfter = await Promise.all(
      dates.flatMap((d) => scopes.map((s) => fundRow(d, s))),
    );
    const figuresAfter = await Promise.all(
      dates.flatMap((d) => scopes.map((s) => figuresOf(d, s))),
    );

    // The frozen fund rows are left untouched on every scope and date.
    expect(fundAfter).toEqual(fundBefore);
    // The five headline figures are unchanged on every scope and date.
    expect(figuresAfter).toEqual(figuresBefore);
    // Reconciliation (ADR 0008) still holds on every snapshot.
    for (const dateKey of dates) {
      for (const scopeId of scopes) {
        expect(await reconciles(store, dateKey, scopeId)).toBe(true);
      }
    }

    store.close();
  });
});
