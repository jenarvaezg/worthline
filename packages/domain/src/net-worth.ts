import type { MoneyMinor } from "./money";
import { addMoney, money, subtractMoney } from "./money";
import type { LiquidityTier } from "./classification";
import { isHousingAsset, isLiquid, rungForLiability, tierOfAsset } from "./classification";
import { LIQUIDITY_LADDER } from "./liquidity-ladder";
import { resolveScopeMemberIds } from "./scope";
import { allocateScopedHolding } from "./scope-allocation";
import type { Liability, ManualAsset, Workspace } from "./workspace-types";

export interface NetWorthSummary {
  scopeId: string;
  totalNetWorth: MoneyMinor;
  liquidNetWorth: MoneyMinor;
  housingEquity: MoneyMinor;
  grossAssets: MoneyMinor;
  debts: MoneyMinor;
}

/**
 * Which figure headlines the dashboard. A framing re-labels the hero number; it
 * never introduces a new figure (see ADR 0003). "total" = net worth (everything),
 * "liquid" = liquid net worth (cash + market tiers).
 */
export type NetWorthFraming = "total" | "liquid";

export type NetWorthBreakdownId =
  | "liquid-net-worth"
  | "housing-equity"
  | "gross-assets"
  | "debts";

export interface NetWorthBreakdownItem {
  id: NetWorthBreakdownId;
  label: string;
  value: MoneyMinor;
}

/**
 * The headline figure for the chosen framing plus the always-visible breakdown.
 * The breakdown is a fixed set, identical across framings — the framing only
 * decides which figure is the hero.
 */
export interface NetWorthPresentation {
  framing: NetWorthFraming;
  headlineLabel: string;
  headline: MoneyMinor;
  breakdown: NetWorthBreakdownItem[];
}

export interface LiquidityComponent {
  id: string;
  name: string;
  valueMinor: number;
}

export interface LiquidityTierBreakdown {
  tier: LiquidityTier;
  netValue: MoneyMinor;
  grossAssets: MoneyMinor;
  debts: MoneyMinor;
  /** This tier's share of the scope's total gross assets, in basis points. */
  shareOfGrossBps: number;
  assets: LiquidityComponent[];
  liabilities: LiquidityComponent[];
}

export const defaultLiquidityTierOrder = [
  "illiquid",
  "term-locked",
  "market",
  "cash",
] as const satisfies readonly LiquidityTier[];

export function calculateNetWorth(input: {
  workspace: Workspace;
  scopeId: string;
  assets: ManualAsset[];
  liabilities?: Liability[];
}): NetWorthSummary {
  const scopeMemberIds = new Set(resolveScopeMemberIds(input.workspace, input.scopeId));
  const currency = input.workspace.baseCurrency;
  const zero = money(0, currency);
  const assetTierById = new Map(
    input.assets.map((asset) => [asset.id, tierOfAsset(asset)]),
  );
  const housingAssetIds = new Set(
    input.assets.filter((asset) => isHousingAsset(asset)).map((asset) => asset.id),
  );

  let grossAssets = zero;
  let liquidAssets = zero;
  let housingAssets = zero;
  let debts = zero;
  let housingDebts = zero;
  let liquidDebts = zero;

  for (const asset of input.assets) {
    const scoped = money(
      allocateScopedHolding(asset.currentValue.amountMinor, {
        ownership: asset.ownership,
        scopeMemberIds,
      }).ownedMinor,
      currency,
    );

    grossAssets = addMoney(grossAssets, scoped);

    if (isHousingAsset(asset)) {
      housingAssets = addMoney(housingAssets, scoped);
    }

    if (isLiquid(tierOfAsset(asset))) {
      liquidAssets = addMoney(liquidAssets, scoped);
    }
  }

  for (const liability of input.liabilities ?? []) {
    const scoped = money(
      allocateScopedHolding(liability.currentBalance.amountMinor, {
        ownership: liability.ownership,
        scopeMemberIds,
      }).ownedMinor,
      currency,
    );

    debts = addMoney(debts, scoped);

    const securesHousing =
      !!liability.associatedAssetId && housingAssetIds.has(liability.associatedAssetId);

    if (securesHousing) {
      housingDebts = addMoney(housingDebts, scoped);
    } else if (isLiquid(rungForLiability(liability, assetTierById))) {
      liquidDebts = addMoney(liquidDebts, scoped);
    }
  }

  return {
    debts,
    grossAssets,
    housingEquity: subtractMoney(housingAssets, housingDebts),
    liquidNetWorth: subtractMoney(liquidAssets, liquidDebts),
    scopeId: input.scopeId,
    totalNetWorth: subtractMoney(grossAssets, debts),
  };
}

export function presentNetWorth(
  summary: NetWorthSummary,
  framing: NetWorthFraming,
): NetWorthPresentation {
  const breakdown: NetWorthBreakdownItem[] = [
    { id: "liquid-net-worth", label: "Neto liquido", value: summary.liquidNetWorth },
    { id: "housing-equity", label: "Vivienda neta", value: summary.housingEquity },
    { id: "gross-assets", label: "Activos brutos", value: summary.grossAssets },
    { id: "debts", label: "Deudas", value: summary.debts },
  ];

  return {
    breakdown,
    framing,
    headline: framing === "liquid" ? summary.liquidNetWorth : summary.totalNetWorth,
    headlineLabel: framing === "liquid" ? "Neto liquido" : "Neto total",
  };
}

export function buildLiquidityBreakdown(input: {
  workspace: Workspace;
  scopeId: string;
  assets: ManualAsset[];
  liabilities?: Liability[];
}): LiquidityTierBreakdown[] {
  const scopeMemberIds = new Set(resolveScopeMemberIds(input.workspace, input.scopeId));
  const currency = input.workspace.baseCurrency;
  const tiers = new Map<LiquidityTier, LiquidityTierBreakdown>();

  for (const tier of defaultLiquidityTierOrder) {
    tiers.set(tier, {
      assets: [],
      debts: money(0, currency),
      grossAssets: money(0, currency),
      liabilities: [],
      netValue: money(0, currency),
      shareOfGrossBps: 0,
      tier,
    });
  }

  const assetTierById = new Map(
    input.assets.map((asset) => [asset.id, tierOfAsset(asset)]),
  );

  for (const asset of input.assets) {
    const breakdown = tiers.get(tierOfAsset(asset));

    if (!breakdown) {
      continue;
    }

    const scopedValue = allocateScopedHolding(asset.currentValue.amountMinor, {
      ownership: asset.ownership,
      scopeMemberIds,
    }).ownedMinor;
    const scoped = money(scopedValue, currency);

    breakdown.grossAssets = addMoney(breakdown.grossAssets, scoped);
    breakdown.netValue = addMoney(breakdown.netValue, scoped);

    if (scopedValue !== 0) {
      breakdown.assets.push({
        id: asset.id,
        name: asset.name,
        valueMinor: scopedValue,
      });
    }
  }

  for (const liability of input.liabilities ?? []) {
    const tier = rungForLiability(liability, assetTierById);
    const breakdown = tiers.get(tier);

    if (!breakdown) {
      continue;
    }

    const scopedValue = allocateScopedHolding(liability.currentBalance.amountMinor, {
      ownership: liability.ownership,
      scopeMemberIds,
    }).ownedMinor;
    const scoped = money(scopedValue, currency);

    breakdown.debts = addMoney(breakdown.debts, scoped);
    breakdown.netValue = subtractMoney(breakdown.netValue, scoped);

    if (scopedValue !== 0) {
      breakdown.liabilities.push({
        id: liability.id,
        name: liability.name,
        valueMinor: scopedValue,
      });
    }
  }

  const totalGross = defaultLiquidityTierOrder.reduce(
    (sum, tier) => sum + tiers.get(tier)!.grossAssets.amountMinor,
    0,
  );

  for (const tier of defaultLiquidityTierOrder) {
    const breakdown = tiers.get(tier)!;
    breakdown.shareOfGrossBps =
      totalGross > 0
        ? Math.round((breakdown.grossAssets.amountMinor / totalGross) * 10_000)
        : 0;
  }

  // Ordered most→least liquid (cash at the top), so the breakdown reads as the
  // liquidity ladder ending in the illiquid rung.
  return LIQUIDITY_LADDER.map((tier) => tiers.get(tier)!);
}
