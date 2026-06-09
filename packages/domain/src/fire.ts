import type { CurrencyCode, MoneyMinor } from "./money";

import { money } from "./money";
import type { ManualAsset, Workspace } from "./index";
import { resolveScopeMemberIds } from "./index";
import { allocateOwnedMoneyMinor } from "./ownership";

export interface FireScopeConfig {
  monthlySpendingMinor: number;
  safeWithdrawalRate: number;
  expectedRealReturn: number;
  currentAge?: number;
  targetRetirementAge?: number;
  excludedAssetIds?: string[];
}

export interface FireResult {
  fireNumber: MoneyMinor;
  eligibleAssets: MoneyMinor;
  percentFunded: number;
  coastFireRequired?: MoneyMinor;
  coastFireAge?: number;
  isAlreadyAtCoastFire?: boolean;
}

export function filterFireEligibleAssets(
  assets: ManualAsset[],
  excludedIds?: string[],
): ManualAsset[] {
  const excludedSet = new Set(excludedIds ?? []);

  return assets.filter(
    (asset) => !asset.isPrimaryResidence && !excludedSet.has(asset.id),
  );
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
  const eligible = filterFireEligibleAssets(assets, config.excludedAssetIds);

  const eligibleAssetsMinor = eligible.reduce((sum, asset) => {
    return (
      sum +
      allocateOwnedMoneyMinor(asset.currentValue.amountMinor, {
        ownership: asset.ownership,
        scopeMemberIds,
      })
    );
  }, 0);

  return calculateFire(config, eligibleAssetsMinor, workspace.baseCurrency);
}
