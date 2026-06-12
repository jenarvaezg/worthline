/**
 * Portfolio projection — scope-weighted rows for the /patrimonio table.
 *
 * Produces two sections (assets / liabilities) whose row values are weighted
 * by the selected scope's ownership share. The sum of projected rows is
 * guaranteed to equal the grossAssets / debts figures that calculateNetWorth
 * reports for the same scope (reconciliation invariant).
 *
 * Investment rows are flagged read-only and carry a detail href, per ADR 0006.
 */

import type { LiquidityTier } from "./classification";
import { tierOfAsset } from "./classification";
import type { MoneyMinor } from "./money";
import { money } from "./money";
import { allocateScopedHolding } from "./scope-allocation";
import type { ScopeOption } from "./scope";
import { resolveScopeMemberIds } from "./scope";
import type { Liability, ManualAsset, OwnershipShare, Workspace } from "./workspace-types";

// ── Tier label translation ───────────────────────────────────────────────────

const TIER_LABELS: Record<LiquidityTier, string> = {
  cash: "Caja",
  housing: "Vivienda",
  illiquid: "Ilíquido",
  market: "Mercado",
  retirement: "Jubilación",
};

function tierLabel(tier: LiquidityTier): string {
  return TIER_LABELS[tier];
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
  tier: LiquidityTier;
  /**
   * True for investment assets — value is derived (units × price), never
   * edited by hand (ADR 0006). The UI should render these read-only.
   */
  isReadOnly: boolean;
  /** Present only for investment assets; links to the detail page. */
  detailHref?: string;
  ownership: RowOwnership;
}

export interface ProjectedLiabilityRow {
  id: string;
  name: string;
  /** Scope-weighted balance in integer minor units (EUR cents). */
  balanceMinor: number;
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
}

// ── Input ────────────────────────────────────────────────────────────────────

export interface PortfolioProjectionInput {
  workspace: Workspace;
  scope: ScopeOption;
  assets: ManualAsset[];
  liabilities: Liability[];
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Project a portfolio into scope-weighted rows suitable for the /patrimonio
 * table. The output guarantees:
 *   sum(rows[assets].valueMinor)    === calculateNetWorth(...).grossAssets.amountMinor
 *   sum(rows[liabilities].balanceMinor) === calculateNetWorth(...).debts.amountMinor
 */
export function projectPortfolio(input: PortfolioProjectionInput): PortfolioProjection {
  const { workspace, scope, assets, liabilities } = input;
  const currency = workspace.baseCurrency;

  const scopeMemberIds = new Set(resolveScopeMemberIds(workspace, scope.id));

  // ── Asset rows ──────────────────────────────────────────────────────────
  const assetRows: ProjectedAssetRow[] = [];
  let grossAssetsMinor = 0;

  for (const asset of assets) {
    const { ownedMinor: scopedValue, totalShareBps: shareBps } = allocateScopedHolding(
      asset.currentValue.amountMinor,
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

    const isInvestment = asset.type === "investment";

    assetRows.push({
      id: asset.id,
      name: asset.name,
      valueMinor: scopedValue,
      tier,
      tierLabel: tierLabel(tier),
      isReadOnly: isInvestment,
      ...(isInvestment ? { detailHref: `/inversiones#${asset.id}` } : {}),
      ownership,
    });

    grossAssetsMinor += scopedValue;
  }

  // ── Liability rows ──────────────────────────────────────────────────────
  const liabilityRows: ProjectedLiabilityRow[] = [];
  let debtsMinor = 0;

  for (const liability of liabilities) {
    const { ownedMinor: scopedValue, totalShareBps: shareBps } = allocateScopedHolding(
      liability.currentBalance.amountMinor,
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

    liabilityRows.push({
      id: liability.id,
      name: liability.name,
      balanceMinor: scopedValue,
      ownership,
    });

    debtsMinor += scopedValue;
  }

  return {
    scope,
    sections: [
      { kind: "assets", rows: assetRows },
      { kind: "liabilities", rows: liabilityRows },
    ],
    totalGrossAssets: money(grossAssetsMinor, currency),
    totalDebts: money(debtsMinor, currency),
  };
}
