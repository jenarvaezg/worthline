import { readStoreTarget } from "@web/read-store-target";
import { withStore } from "@web/store";
import type { StoreTarget } from "@web/store-resolver";
import { type InvestmentAssetRef, refreshStalePrices } from "@worthline/pricing";
import { after } from "next/server";

/**
 * The first quote of a just-created investment (#1314).
 *
 * An alta with a provider symbol lands with NO row in `asset_price_cache`: until
 * the 21:00 capture (or the manual «Actualizar precios») runs, the holding is
 * valued at its acquisition cost and every present-time price read is a miss.
 * `refreshStalePrices` already selects "assets with no cache row yet, so
 * newly-created investments get a first quote" — this is the seam that invokes it
 * at creation time, from both altas: the wizard and the assistant's confirm.
 *
 * Deferred past the response with `after()`: the provider chain retries and falls
 * back over tens of seconds in the bad case, and the confirm of an
 * alta must never wait on it. The deferred pass opens its OWN store — the caller's
 * connection closes with the response — against the target resolved while the
 * request scope is still alive, so nothing reads cookies after the fact.
 *
 * Best-effort in both directions: a provider outage degrades to the usual `failed`
 * cache row, and any failure (provider, store, control plane) is logged and
 * swallowed — the holding is already written and its alta already succeeded.
 */
export async function fetchFirstQuoteBestEffort(
  asset: InvestmentAssetRef,
  nowIso: string,
): Promise<void> {
  if (!asset.providerSymbol) {
    return;
  }
  try {
    const target = await readStoreTarget();
    after(() => cacheFirstQuote(asset, nowIso, target));
  } catch {
    // No request scope (a script, or a unit test calling the action directly):
    // there is nothing to defer to, and the alta must not pay for a provider
    // round-trip inline. The daily capture still picks the quote up.
  }
}

async function cacheFirstQuote(
  asset: InvestmentAssetRef,
  nowIso: string,
  target: StoreTarget,
): Promise<void> {
  try {
    // Empty cache entries, and never `force`: the asset is selected because it has
    // no cache row yet, so a symbol that somehow already got its first quote is
    // not refetched behind the user's back.
    const { refreshed } = await refreshStalePrices([], [asset], nowIso);
    if (refreshed.length === 0) {
      return;
    }
    await withStore(
      (store) => store.operations.upsertPrices(refreshed),
      target,
      "first-quote",
    );
  } catch (error) {
    console.error("First quote fetch failed", {
      assetId: asset.id,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
