/**
 * Performance harness seeding helper (issue #200).
 *
 * Builds a single, fully deterministic worthline workspace large enough to
 * exercise the hot paths the performance audit flagged: dashboard load, frozen
 * holding reads, investment position projection, and historical snapshot ripple.
 *
 * Determinism is load-bearing — the harness measures the SAME work every run, so
 * a regression shows up as a timing change and not as seed drift. Every figure,
 * date, and id below is fixed; there is no randomness and NO external provider is
 * touched (manual prices and manual valuations only, mirroring the established
 * no-network test fakes in tests/*.persistence and tests/*.wiring suites).
 *
 * Seeding invariants (keep these stable — changing them shifts every timing):
 *  - household + 2 members (Ana 60% / Jose 40% style ownership splits)
 *  - 9 manual assets spanning every liquidity tier (cash, market, term, illiquid)
 *    plus 2 housing assets with appraisal/improvement anchors and a rate
 *  - 3 investment assets, each with backdated buy/sell operations over ~2 years
 *    (≈ OPERATIONS_PER_INVESTMENT × 3 operations total)
 *  - 1 amortizable mortgage (with a plan + an early repayment) securing a house,
 *    1 revolving credit with a balance anchor, 1 plain cash debt
 *  - a full historical backfill so ≈ 2 months of daily snapshots plus the
 *    per-cuota mortgage snapshots already exist in the DB before measuring
 */

import type { WorthlineStore } from "@worthline/db";
import { listScopeOptions } from "@worthline/domain";

/** Anchor "today" for the seed. Fixed so the generated history is identical every run. */
export const SEED_TODAY = "2026-06-15";

/** How many buy operations each investment accrues across the 24-month window. */
export const OPERATIONS_PER_INVESTMENT = 24;

/** The scope ids a household workspace exposes (household first, then members). */
export const SEED_SCOPE_IDS = ["household", "member_ana", "member_jose"] as const;

/** A backdated operation date, `monthsAgo` whole months before SEED_TODAY. */
function dateMonthsAgo(monthsAgo: number): string {
  const base = new Date(`${SEED_TODAY}T00:00:00.000Z`);
  base.setUTCMonth(base.getUTCMonth() - monthsAgo);
  return base.toISOString().slice(0, 10);
}

/** A daily date, `daysAgo` days before SEED_TODAY (used to seed dense recent history). */
function dateDaysAgo(daysAgo: number): string {
  const base = new Date(`${SEED_TODAY}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() - daysAgo);
  return base.toISOString().slice(0, 10);
}

interface SeedResult {
  /** The investment asset whose backdated operations exercise the operation ripple. */
  rippleInvestmentId: string;
  /** The date to ripple a backdated operation from (early in the snapshot history). */
  rippleOperationDateKey: string;
  /** The housing asset whose valuation curve exercises the valuation ripple. */
  rippleHousingId: string;
  /** The date to ripple a housing valuation change from (early in the history). */
  rippleValuationDateKey: string;
  /** The amortizable mortgage whose curve exercises the debt ripple. */
  rippleDebtId: string;
}

/**
 * Seed a representative workspace into `store`. Returns the ids/dates the harness
 * needs to drive each ripple path. All work is deterministic and network-free.
 */
export async function seedPerformanceWorkspace(
  store: WorthlineStore,
): Promise<SeedResult> {
  await store.workspace.initializeWorkspace({
    members: [
      { id: "member_ana", name: "Ana" },
      { id: "member_jose", name: "Jose" },
    ],
    mode: "household",
  });

  // ── Cash & liquid manual assets (liquidity ladder: cash + market tiers) ──────
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 42_000_00,
    id: "asset_checking",
    liquidityTier: "cash",
    name: "Cuenta corriente",
    ownership: [
      { memberId: "member_ana", shareBps: 6_000 },
      { memberId: "member_jose", shareBps: 4_000 },
    ],
    type: "cash",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 18_500_00,
    id: "asset_savings",
    liquidityTier: "cash",
    name: "Cuenta de ahorro",
    ownership: [{ memberId: "member_ana", shareBps: 10_000 }],
    type: "cash",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 9_750_00,
    id: "asset_brokerage_cash",
    liquidityTier: "market",
    name: "Liquidez del broker",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "cash",
  });

  // ── Term-locked & illiquid manual assets ────────────────────────────────────
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 30_000_00,
    id: "asset_term_deposit",
    liquidityTier: "term",
    name: "Deposito a plazo",
    ownership: [
      { memberId: "member_ana", shareBps: 5_000 },
      { memberId: "member_jose", shareBps: 5_000 },
    ],
    type: "cash",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 12_000_00,
    id: "asset_collectibles",
    liquidityTier: "illiquid",
    name: "Coleccion de arte",
    ownership: [{ memberId: "member_ana", shareBps: 10_000 }],
    // "other" is the INSTRUMENT (ADR 0014), not the AssetType — the stored kind
    // is "manual" (hand-valued), matching precious_metal/vehicle/other's shared
    // `stored` valuation method (packages/domain/src/instrument-catalog.ts).
    type: "manual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 8_400_00,
    id: "asset_vehicle",
    liquidityTier: "illiquid",
    name: "Vehiculo",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "manual",
  });

  // ── Housing assets (appreciating, with appraisal + improvement anchors) ──────
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 320_000_00,
    id: "asset_home",
    isPrimaryResidence: true,
    liquidityTier: "illiquid",
    name: "Vivienda habitual",
    ownership: [
      { memberId: "member_ana", shareBps: 5_000 },
      { memberId: "member_jose", shareBps: 5_000 },
    ],
    type: "real_estate",
  });
  await store.assets.setAnnualAppreciationRate("asset_home", "0.03");
  await store.assets.addValuationAnchor({
    adjustsPriorCurve: true,
    assetId: "asset_home",
    id: "anchor_home_appraisal",
    valuationDate: dateMonthsAgo(20),
    valueMinor: 300_000_00,
  });
  await store.assets.addValuationAnchor({
    adjustsPriorCurve: false,
    assetId: "asset_home",
    id: "anchor_home_improvement",
    valuationDate: dateMonthsAgo(8),
    valueMinor: 12_000_00,
  });

  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 145_000_00,
    id: "asset_rental",
    liquidityTier: "illiquid",
    name: "Piso en alquiler",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "real_estate",
  });
  await store.assets.setAnnualAppreciationRate("asset_rental", "0.025");
  await store.assets.addValuationAnchor({
    adjustsPriorCurve: true,
    assetId: "asset_rental",
    id: "anchor_rental_appraisal",
    valuationDate: dateMonthsAgo(18),
    valueMinor: 138_000_00,
  });

  // ── Investments with backdated operations (position projection + ripple) ─────
  const investments: Array<{
    id: string;
    name: string;
    price: string;
    memberId: string;
  }> = [
    {
      id: "asset_etf_world",
      memberId: "member_ana",
      name: "ETF MSCI World",
      price: "98.40",
    },
    { id: "asset_etf_bonds", memberId: "member_jose", name: "ETF Bonos", price: "52.10" },
    {
      id: "asset_stock_tech",
      memberId: "member_ana",
      name: "Accion Tech",
      price: "210.75",
    },
  ];

  for (const investment of investments) {
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: investment.id,
      manualPricePerUnit: investment.price,
      name: investment.name,
      ownership: [{ memberId: investment.memberId, shareBps: 10_000 }],
      unitSymbol: investment.name.slice(0, 4).toUpperCase(),
    });

    // A deterministic ladder of monthly buys over the 24-month window. Each buy
    // is a fixed number of units at a fixed price, so cost basis and units are
    // identical every run.
    for (let i = 0; i < OPERATIONS_PER_INVESTMENT; i++) {
      const monthsAgo = OPERATIONS_PER_INVESTMENT - i; // oldest first
      await store.operations.recordOperation({
        assetId: investment.id,
        currency: "EUR",
        executedAt: dateMonthsAgo(monthsAgo),
        id: `${investment.id}_op_${i}`,
        kind: "buy",
        pricePerUnit: (40 + i).toString(),
        units: "3",
      });
    }
  }

  // ── Liabilities (amortizable mortgage + revolving credit + plain debt) ───────
  // Plain cash debt — no model, last-known-value basis.
  await store.liabilities.createLiability({
    balanceMinor: 6_000_00,
    currency: "EUR",
    id: "liability_personal_loan",
    name: "Prestamo personal",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "debt",
  });

  // Revolving credit — a balance anchor in the past drives its historical curve.
  await store.liabilities.createLiability({
    balanceMinor: 3_200_00,
    currency: "EUR",
    id: "liability_credit_card",
    name: "Tarjeta de credito",
    ownership: [{ memberId: "member_ana", shareBps: 10_000 }],
    type: "debt",
  });
  await store.liabilities.setDebtModel("liability_credit_card", "revolving");
  await store.liabilities.addBalanceAnchor({
    anchorDate: dateMonthsAgo(2),
    balanceMinor: 4_100_00,
    id: "anchor_card",
    liabilityId: "liability_credit_card",
  });

  // Amortizable mortgage securing the home (ADR 0013 offset, ADR 0019 dates).
  await store.liabilities.createLiability({
    associatedAssetId: "asset_home",
    balanceMinor: 180_000_00,
    currency: "EUR",
    id: "liability_mortgage",
    name: "Hipoteca vivienda",
    ownership: [
      { memberId: "member_ana", shareBps: 5_000 },
      { memberId: "member_jose", shareBps: 5_000 },
    ],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("liability_mortgage", "amortizable");
  // The mortgage plan ripple lays down one snapshot per past cuota (ADR 0012
  // exception, PRD #109) — it rides the debt seam together with the plan persist.
  await store.command.createAmortizationPlan(
    {
      annualInterestRate: "0.021",
      disbursementDate: dateMonthsAgo(20),
      firstPaymentDate: dateMonthsAgo(19),
      id: "plan_mortgage",
      initialCapitalMinor: 200_000_00,
      liabilityId: "liability_mortgage",
      termMonths: 300,
    },
    { today: SEED_TODAY },
  );
  // A past early repayment re-derives the curve from its date forward — persist +
  // ripple ride the debt seam.
  await store.command.addEarlyRepayment(
    {
      amountMinor: 5_000_00,
      id: "repayment_mortgage",
      mode: "reduce-term",
      planId: "plan_mortgage",
      repaymentDate: dateMonthsAgo(6),
    },
    { liabilityId: "liability_mortgage", today: SEED_TODAY },
  );

  // ── Generate the historical snapshots ───────────────────────────────────────
  // The full backfill fills every other past operation/anchor date. Together with
  // the debt-seam ripples above they seed the dense history the dashboard and
  // ripple paths read.
  await store.command.backfillHistoricalSnapshots(SEED_TODAY);

  // Add a dense run of recent daily snapshots (≈ 2 months) on top of the
  // milestone history, so the dashboard read paths face a realistic row count.
  for (let daysAgo = 60; daysAgo >= 1; daysAgo--) {
    const dateKey = dateDaysAgo(daysAgo);
    // Re-value the checking account fractionally so each day is a distinct,
    // deterministic capture rather than a same-day upsert.
    await store.assets.updateAssetValuation("asset_checking", 42_000_00 + daysAgo * 1_00);
    // Generate a snapshot at this day via the valuation seam: a zero-value home
    // improvement is a dated fact that lands a fresh snapshot at `dateKey` (folding
    // the re-valued checking row) while leaving the home's curve value unchanged.
    await store.command.addValuationAnchor(
      {
        adjustsPriorCurve: false,
        assetId: "asset_home",
        id: `daily_${dateKey}`,
        valuationDate: dateKey,
        valueMinor: 0,
      },
      { today: SEED_TODAY },
    );
  }

  return {
    rippleDebtId: "liability_mortgage",
    rippleHousingId: "asset_home",
    rippleInvestmentId: "asset_etf_world",
    rippleOperationDateKey: dateMonthsAgo(18),
    rippleValuationDateKey: dateMonthsAgo(16),
  };
}

/**
 * The measured size of a seeded workspace — the "large workspace" baseline the
 * performance budgets are conservative against (#203). Recorded explicitly so the
 * budgets are anchored to a documented scale: if the seed grows, this baseline is
 * what a reviewer compares against when deciding whether a budget change is the
 * domain workload changing (re-baseline + adjust budgets) or a regression.
 */
export interface SeedDimensions {
  /** Household members (drives ownership-split fan-out across scopes). */
  members: number;
  /** Manual + investment + housing assets read on every dashboard load. */
  assets: number;
  /** Mortgage + revolving credit + plain debt the liability curves cover. */
  liabilities: number;
  /** Scopes (household + one per member) the capture loop iterates. */
  scopes: number;
  /** Investment positions projected from operations. */
  positions: number;
  /** Net-worth snapshots stored for the household scope. */
  householdSnapshots: number;
  /** Net-worth snapshots stored across every scope. */
  totalSnapshots: number;
  /** Frozen holding rows stored for the household scope (the dense read path). */
  householdHoldingRows: number;
  /** Frozen holding rows stored across every scope. */
  totalHoldingRows: number;
}

/**
 * The documented large-workspace baseline (#203, AC: "documents the seeded
 * workspace dimensions used as the large-workspace baseline"). These are the
 * dimensions seedPerformanceWorkspace produces as it returns, BEFORE the harness
 * runs any capture/ripple of its own. The harness asserts the live seed matches
 * this record, so the budgets can never silently drift off their stated scale: a
 * seed change is a deliberate edit here (and a budget review), not an accident.
 */
export const SEED_DIMENSIONS: SeedDimensions = {
  assets: 11,
  householdHoldingRows: 1_126,
  householdSnapshots: 83,
  liabilities: 3,
  members: 2,
  positions: 3,
  scopes: 3,
  totalHoldingRows: 2_576,
  totalSnapshots: 249,
};

/**
 * Measure the dimensions of an already-seeded `store`, reading them straight from
 * the store the same way the dashboard/read paths do. Used by the harness to
 * assert the live seed matches the documented {@link SEED_DIMENSIONS} baseline.
 */
export async function measureSeedDimensions(
  store: WorthlineStore,
): Promise<SeedDimensions> {
  const workspace = (await store.workspace.readWorkspace())!;
  return {
    assets: (await store.assets.readAssets()).length,
    householdHoldingRows: (
      await store.snapshots.readSnapshotHoldings({
        scopeId: "household",
      })
    ).length,
    householdSnapshots: (await store.snapshots.readSnapshots("household")).length,
    liabilities: (await store.liabilities.readLiabilities()).length,
    members: workspace.members.length,
    positions: (await store.snapshots.readPositions("household")).length,
    scopes: listScopeOptions(workspace).length,
    totalHoldingRows: (await store.snapshots.readSnapshotHoldings()).length,
    totalSnapshots: (await store.snapshots.readSnapshots()).length,
  };
}
