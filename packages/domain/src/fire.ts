import type { CurrencyCode, MoneyMinor } from "./money";

import { money } from "./money";
import type { ManualAsset, Workspace } from "./workspace-types";
import { resolveScopeMemberIds } from "./scope";
import { allocateScopedHolding } from "./scope-allocation";

export interface FireScopeConfig {
  monthlySpendingMinor: number;
  safeWithdrawalRate: number;
  expectedRealReturn: number;
  currentAge?: number;
  targetRetirementAge?: number;
  excludedAssetIds?: string[];
  /**
   * Editable monthly savings capacity in minor units (PRD #421, #425): the
   * default contribution the FIRE projection assumes. Optional — when unset the
   * UI offers a suggestion from operations history (`suggestMonthlySavingsCapacity`)
   * but never writes it implicitly; the projection treats `undefined` as 0.
   */
  monthlySavingsCapacityMinor?: number;
}

/**
 * Why an asset is held out of the FIRE-eligible total. `primary_residence`
 * comes from the asset's own flag; `manual` comes from `config.excludedAssetIds`.
 */
export type FireExclusionReason = "primary_residence" | "manual";

export interface FireExcludedAsset {
  id: string;
  name: string;
  reason: FireExclusionReason;
}

export interface FireResult {
  fireNumber: MoneyMinor;
  eligibleAssets: MoneyMinor;
  percentFunded: number;
  /**
   * Assets owned within the scope that were left OUT of `eligibleAssets`, with
   * the reason. Powers the dashboard "¿Qué cuenta como elegible?" disclosure
   * (#266). Empty for `calculateFire` (it only sees a total, not the assets).
   */
  excludedAssets: FireExcludedAsset[];
  coastFireRequired?: MoneyMinor;
  coastFireAge?: number;
  isAlreadyAtCoastFire?: boolean;
}

export function calculateFire(
  config: FireScopeConfig,
  eligibleAssetsMinor: number,
  currency: CurrencyCode,
): FireResult {
  const fireNumberMinor = Math.round(
    (config.monthlySpendingMinor * 12) / config.safeWithdrawalRate,
  );

  const percentFunded =
    fireNumberMinor > 0 ? (eligibleAssetsMinor / fireNumberMinor) * 100 : 0;

  const result: FireResult = {
    fireNumber: money(fireNumberMinor, currency),
    eligibleAssets: money(eligibleAssetsMinor, currency),
    percentFunded,
    excludedAssets: [],
  };

  if (config.currentAge !== undefined) {
    const targetRetirementAge = config.targetRetirementAge ?? 65;
    const yearsToRetirement = targetRetirementAge - config.currentAge;
    const growthFactor = Math.pow(1 + config.expectedRealReturn, yearsToRetirement);
    const coastFireRequiredMinor = Math.round(fireNumberMinor / growthFactor);

    result.coastFireRequired = money(coastFireRequiredMinor, currency);
    result.isAlreadyAtCoastFire = eligibleAssetsMinor >= coastFireRequiredMinor;

    if (eligibleAssetsMinor > 0 && fireNumberMinor > eligibleAssetsMinor) {
      result.coastFireAge =
        config.currentAge +
        Math.log(fireNumberMinor / eligibleAssetsMinor) /
          Math.log(1 + config.expectedRealReturn);
    }
  }

  return result;
}

export function calculateFireForScope(
  config: FireScopeConfig,
  assets: ManualAsset[],
  workspace: Workspace,
  scopeId: string,
): FireResult {
  const scopeMemberIds = new Set(resolveScopeMemberIds(workspace, scopeId));
  const excludedSet = new Set(config.excludedAssetIds ?? []);

  let eligibleAssetsMinor = 0;
  const excludedAssets: FireExcludedAsset[] = [];

  for (const asset of assets) {
    const ownedMinor = allocateScopedHolding(asset.currentValue.amountMinor, {
      ownership: asset.ownership,
      scopeMemberIds,
    }).ownedMinor;

    const reason: FireExclusionReason | null = asset.isPrimaryResidence
      ? "primary_residence"
      : excludedSet.has(asset.id)
        ? "manual"
        : null;

    if (reason === null) {
      eligibleAssetsMinor += ownedMinor;
      continue;
    }

    // Scope-relative: only surface what the scope actually holds. An excluded
    // asset owned entirely outside this scope contributes nothing either way,
    // so listing it would just be noise.
    if (ownedMinor > 0) {
      excludedAssets.push({ id: asset.id, name: asset.name, reason });
    }
  }

  return {
    ...calculateFire(config, eligibleAssetsMinor, workspace.baseCurrency),
    excludedAssets,
  };
}
