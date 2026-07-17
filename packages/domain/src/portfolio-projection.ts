/**
 * Portfolio projection — scope-weighted rows for the /patrimonio table.
 *
 * Produces two sections (assets / liabilities) whose row values are weighted
 * by the selected scope's ownership share. The sum of projected rows is
 * guaranteed to equal the grossAssets / debts figures that calculateNetWorth
 * reports for the same scope (reconciliation invariant).
 *
 * Every row is a first-class, fully-actionable holding: it carries a `detailHref`
 * to its ficha (edit/manage) and participates in the normal row actions. An
 * investment's VALUE stays derived (units × price, ADR 0006) — the row flags this
 * via `valueIsDerived` so the UI renders the value read-only — but the row itself
 * is no longer a ghost (#154, S8). Each row also exposes its `instrument` and
 * `tier` (rung) so the list can group/filter by direction, rung or instrument.
 */

import type { Instrument, LiquidityTier } from "./classification";
import { instrumentOfAsset, rungForLiability, tierOfAsset } from "./classification";
import type { FxAggregation, FxExcludedHolding } from "./fx";
import { resolveToBaseCurrency } from "./fx";
import { defaultInstrumentForLiability } from "./instrument-catalog";
import { LIQUIDITY_TIER_LABELS } from "./liquidity-ladder";
import type { MoneyMinor } from "./money";
import { money } from "./money";
import type { PriceSource } from "./prices";
import type { ScopeOption } from "./scope";
import { resolveScopeMemberIds } from "./scope";
import { allocateScopedHolding } from "./scope-allocation";
import type {
  Liability,
  ManualAsset,
  OwnershipShare,
  Workspace,
} from "./workspace-types";

// ── Tier label translation ───────────────────────────────────────────────────

function tierLabel(tier: LiquidityTier): string {
  return LIQUIDITY_TIER_LABELS[tier];
}

// ── Ownership summary attached to every row ──────────────────────────────────

/**
 * The member-level ownership shares for one row, plus the aggregate share
 * (in bps) that falls within the projected scope.
 */
export interface RowOwnership {
  /** All ownership shares on the underlying holding. */
  shares: OwnershipShare[];
  /**
   * The sum of bps belonging to the scope's members.
   * 10_000 = 100% in household (all members), ≤10_000 in member scope.
   */
  totalShareBps: number;
}

// ── Projected row types ──────────────────────────────────────────────────────

export interface ProjectedAssetRow {
  id: string;
  name: string;
  /** Scope-weighted value in integer minor units (EUR cents). */
  valueMinor: number;
  tierLabel: string;
  /** The holding's rung on the liquidity ladder — a group/filter key (#154). */
  tier: LiquidityTier;
  /** What the holding is (fund, property, current_account…) — a group/filter key (#154). */
  instrument: Instrument;
  /**
   * True when the value is derived (units × price) and never hand-editable
   * (ADR 0006 — investments). This gates only how the VALUE is rendered (read-only),
   * NOT the row's actions: every row edits/deletes through its ficha (#154, S8).
   */
  valueIsDerived: boolean;
  /**
   * When the value was derived from a cached provider price, the ISO instant that
   * price was last refreshed (issue #303); null for hand-valued holdings, for an
   * investment with no cached price yet, and for connected sources (`type: manual`).
   * The UI turns it into a relative ("hace 2 días") / absolute ("8 jun 2026") date.
   */
  priceFetchedAt: string | null;
  /**
   * The source that supplied the cached price (`yahoo`/`stooq`/`finect`/…), paired
   * with `priceFetchedAt` (issue #303); null in exactly the same cases. The UI maps
   * the raw code to a display label.
   */
  priceSource: PriceSource | null;
  /** Every row links to its ficha — the single place a holding is edited/managed (#154). */
  detailHref: string;
  ownership: RowOwnership;
}

export interface ProjectedLiabilityRow {
  id: string;
  name: string;
  /** Scope-weighted balance in integer minor units (EUR cents). */
  balanceMinor: number;
  /** The rung the debt sits on — inherited from the asset it secures (#154 grouping). */
  tier: LiquidityTier;
  tierLabel: string;
  /** Coarse instrument (mortgage vs loan) for grouping — refined surfaces live on the ficha. */
  instrument: Instrument;
  /** Every liability links to its ficha — the single place it is edited/managed (#154). */
  detailHref: string;
  ownership: RowOwnership;
}

// ── Section types ────────────────────────────────────────────────────────────

export interface AssetsSection {
  kind: "assets";
  rows: ProjectedAssetRow[];
}

export interface LiabilitiesSection {
  kind: "liabilities";
  rows: ProjectedLiabilityRow[];
}

export type PortfolioSection = AssetsSection | LiabilitiesSection;

// ── Top-level result ─────────────────────────────────────────────────────────

export interface PortfolioProjection {
  scope: ScopeOption;
  sections: [AssetsSection, LiabilitiesSection];
  /** Gross assets for the scope — equals sum of asset row values. */
  totalGrossAssets: MoneyMinor;
  /** Total debts for the scope — equals sum of liability row balances. */
  totalDebts: MoneyMinor;
  /**
   * Holdings with no convertible rate to the base currency (#1065): excluded from
   * both the rows and the totals above, so the reconciliation invariant with
   * calculateNetWorth still holds (both exclude exactly the same set). Empty for
   * an all-EUR portfolio.
   */
  fxExcluded: FxExcludedHolding[];
}

// ── Input ────────────────────────────────────────────────────────────────────

/** When + by which source an asset's cached unit price was last refreshed (#303). */
export interface PriceRefreshMeta {
  /** ISO instant the cached price was last fetched. */
  fetchedAt: string;
  /** The source that supplied the cached price. */
  source: PriceSource;
}

export interface PortfolioProjectionInput {
  workspace: Workspace;
  scope: ScopeOption;
  assets: ManualAsset[];
  liabilities: Liability[];
  /**
   * Price-refresh metadata keyed by asset id (issue #303), read from the asset
   * price cache. Optional — when absent every row's metadata stays null. Only
   * `type: "investment"` rows ever surface it; entries for other kinds are ignored.
   */
  priceMetaByAsset?: Map<string, PriceRefreshMeta>;
  /**
   * FX context (#1065). When present, non-base-currency holdings are converted to
   * the base currency at `asOf`; when absent, or a rate is missing, they are excluded
   * from the rows and totals and reported in `fxExcluded`. Must match the `fx` passed
   * to calculateNetWorth for the same scope or the reconciliation invariant breaks.
   */
  fx?: FxAggregation;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Project a portfolio into scope-weighted rows suitable for the /patrimonio
 * table. The output guarantees:
 *   sum(rows[assets].valueMinor)    === calculateNetWorth(...).grossAssets.amountMinor
 *   sum(rows[liabilities].balanceMinor) === calculateNetWorth(...).debts.amountMinor
 */
export function projectPortfolio(input: PortfolioProjectionInput): PortfolioProjection {
  const { workspace, scope, assets, liabilities, priceMetaByAsset } = input;
  const currency = workspace.baseCurrency;

  const scopeMemberIds = new Set(resolveScopeMemberIds(workspace, scope.id));
  const fxExcluded: FxExcludedHolding[] = [];

  // ── Asset rows ──────────────────────────────────────────────────────────
  const assetRows: ProjectedAssetRow[] = [];
  let grossAssetsMinor = 0;

  for (const asset of assets) {
    // Convert to the base currency BEFORE scoping, so a non-convertible holding is
    // excluded here — from both rows and gross — exactly as calculateNetWorth
    // excludes it (the reconciliation invariant). All-EUR values pass through.
    const resolvedValue = resolveToBaseCurrency(asset.currentValue, currency, input.fx);
    if (!resolvedValue.ok) {
      fxExcluded.push({
        holdingId: asset.id,
        name: asset.name,
        original: asset.currentValue,
        reason: resolvedValue.reason,
      });
      continue;
    }

    const { ownedMinor: scopedValue, totalShareBps: shareBps } = allocateScopedHolding(
      resolvedValue.value.amountMinor,
      { ownership: asset.ownership, scopeMemberIds },
    );

    // Exclude rows where the scope has no ownership stake at all.
    // Zero-value assets that ARE owned by the scope must still appear so
    // their warnings (and the "Es intencional" override button) are reachable.
    if (shareBps === 0) {
      continue;
    }

    const tier = tierOfAsset(asset);

    const ownership: RowOwnership = {
      shares: asset.ownership,
      totalShareBps: shareBps,
    };

    // Price-refresh metadata rides ONLY investments valued from a cached provider
    // price (#303): connected sources are `type: "manual"` and so never match, and
    // a manual-priced investment has no cache entry, so both stay null.
    const priceMeta =
      asset.type === "investment" ? (priceMetaByAsset?.get(asset.id) ?? null) : null;

    assetRows.push({
      id: asset.id,
      name: asset.name,
      valueMinor: scopedValue,
      tier,
      tierLabel: tierLabel(tier),
      instrument: instrumentOfAsset(asset),
      // An investment's value is derived (units × price, ADR 0006) so the list
      // renders it read-only — but the ROW is a first-class holding (#154, S8):
      // it edits/manages through its ficha like any other, no longer a ghost.
      valueIsDerived: asset.type === "investment",
      priceFetchedAt: priceMeta?.fetchedAt ?? null,
      priceSource: priceMeta?.source ?? null,
      // Every holding's ficha is /patrimonio/[id]/editar — the single place it is
      // managed since S6 (#152) dispatches by valuation method (investments get
      // the operations editor, not the transitional /inversiones view).
      detailHref: `/patrimonio/${asset.id}/editar`,
      ownership,
    });

    grossAssetsMinor += scopedValue;
  }

  // ── Liability rows ──────────────────────────────────────────────────────
  // A debt inherits the rung of the asset it secures (ADR 0013), so build the
  // asset-rung map once and resolve each liability's rung against it (#154 grouping).
  const assetRungById = new Map(assets.map((asset) => [asset.id, tierOfAsset(asset)]));

  const liabilityRows: ProjectedLiabilityRow[] = [];
  let debtsMinor = 0;

  for (const liability of liabilities) {
    const resolvedBalance = resolveToBaseCurrency(
      liability.currentBalance,
      currency,
      input.fx,
    );
    if (!resolvedBalance.ok) {
      fxExcluded.push({
        holdingId: liability.id,
        name: liability.name,
        original: liability.currentBalance,
        reason: resolvedBalance.reason,
      });
      continue;
    }

    const { ownedMinor: scopedValue, totalShareBps: shareBps } = allocateScopedHolding(
      resolvedBalance.value.amountMinor,
      { ownership: liability.ownership, scopeMemberIds },
    );

    // Exclude rows where the scope holds 0% of this liability.
    if (scopedValue === 0) {
      continue;
    }

    const ownership: RowOwnership = {
      shares: liability.ownership,
      totalShareBps: shareBps,
    };

    const tier = rungForLiability(liability, assetRungById);

    liabilityRows.push({
      id: liability.id,
      name: liability.name,
      balanceMinor: scopedValue,
      tier,
      tierLabel: tierLabel(tier),
      // Coarse instrument for grouping: a mortgage stays a mortgage, every other
      // debt is a loan. The revolving/informal refinement needs the debt model
      // (only on the ficha), and the list only distinguishes Hipoteca/Deuda.
      instrument: defaultInstrumentForLiability(liability.type, null),
      detailHref: `/patrimonio/${liability.id}/editar`,
      ownership,
    });

    debtsMinor += scopedValue;
  }

  return {
    fxExcluded,
    scope,
    sections: [
      { kind: "assets", rows: assetRows },
      { kind: "liabilities", rows: liabilityRows },
    ],
    totalGrossAssets: money(grossAssetsMinor, currency),
    totalDebts: money(debtsMinor, currency),
  };
}
