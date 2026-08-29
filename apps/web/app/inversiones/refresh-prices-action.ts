"use server";

/**
 * Manual price refresh (#317/#405/#406, ADR 0026).
 *
 * The whole portfolio from /patrimonio, or one holding when the form carries an
 * `assetId`. Its own module since #1606: the only investment action that talks to
 * the network on the happy path.
 */

import {
  isClock,
  runActionWithStore,
  testArgFromActionArgs,
  testStoreFromActionArgs,
} from "@web/action-store";
import { guardDemoWrite } from "@web/demo/write-guard";
import { pricesRefreshedRedirectUrl } from "@web/intake";
import { currentUrlOf } from "@web/inversiones/return-url";
import { systemClock } from "@worthline/domain";
import {
  fetchAndCachePrice,
  type PriceProvider,
  refreshStalePrices,
} from "@worthline/pricing";
import { redirect } from "next/navigation";

function isPriceProvider(value: unknown): value is PriceProvider {
  return typeof value === "object" && value !== null && "fetchPrice" in value;
}

export async function refreshPricesAction(formData: FormData, ..._testArgs: unknown[]) {
  const _store = testStoreFromActionArgs(_testArgs);
  const _provider = testArgFromActionArgs(_testArgs, isPriceProvider);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(currentUrlOf(formData, "/patrimonio"));
  const returnUrl = currentUrlOf(formData, "/patrimonio");
  const nowIso = _clock.now();

  const allInvestmentAssets = await runActionWithStore(
    (store) => store.assets.readInvestmentAssetsWithMeta(),
    _store,
  );

  // #406: an `assetId` form field narrows the force-refresh to a single holding's
  // ficha; absent → the whole portfolio (the global /patrimonio trigger, #405).
  // Scoping `investmentAssets` here flows to both the injected-provider path and
  // the real `refreshStalePrices` path below.
  const scopeAssetId = String(formData.get("assetId") ?? "").trim();
  const investmentAssets = scopeAssetId
    ? allInvestmentAssets.filter((asset) => asset.id === scopeAssetId)
    : allInvestmentAssets;

  const refreshable = investmentAssets.filter((asset) => Boolean(asset.providerSymbol));

  const outcome = await (async () => {
    if (_provider) {
      const provider = _provider;
      const results = await Promise.all(
        refreshable.map(async (asset) => {
          const price = await fetchAndCachePrice(provider, {
            assetId: asset.id,
            symbol: asset.providerSymbol!,
            currency: asset.currency,
            nowIso,
          });
          await runActionWithStore(
            (store) => store.operations.upsertPrice(price),
            _store,
          );

          return { price, symbol: asset.providerSymbol! };
        }),
      );

      return {
        failures: results
          .filter((entry) => entry.price.freshnessState === "failed")
          .map((entry) => ({
            symbol: entry.symbol,
            reason: entry.price.staleReason ?? "",
          })),
        updated: results.filter((entry) => entry.price.freshnessState === "fresh").length,
      };
    }

    // Manual refresh refetches EVERY configured asset regardless of cache
    // staleness (#317 / ADR 0026). `force: true` is the honest replacement for
    // the old `forcedStaleCache` hack, which fabricated epoch-dated `stooq` rows
    // purely to defeat `selectStalePrices`. The cache row is still the persist
    // unit — refresh keeps owning cache policy.
    const result = await refreshStalePrices([], investmentAssets, nowIso, {
      force: true,
    });

    if (result.refreshed.length > 0) {
      await runActionWithStore(
        (store) => store.operations.upsertPrices(result.refreshed),
        _store,
      );
    }

    return {
      failures: result.failures,
      updated: result.updated,
    };
  })();

  redirect(pricesRefreshedRedirectUrl(returnUrl, outcome));
}
