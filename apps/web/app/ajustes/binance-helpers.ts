/**
 * Pure helpers for the Binance connected-source TILE (PRD #245/#248, ADR 0021).
 * Kept free of Next.js, the store, and the network so the ajustes tile stays thin
 * glue and the cross-rung value aggregation is unit-testable.
 *
 * Credential shaping/read-back moved into the Binance ADAPTER (#322, ADR 0027):
 * `binanceAdapter.parseConnectForm` / `serializeCredentials` / `readCredentials`
 * now single-source that logic. Ownership resolution and last-sync formatting are
 * generic across adapters, so they are re-exported from numista-helpers.
 */

export { formatLastSync, resolveConnectingOwnership } from "./numista-helpers";

/** The minimal asset shape `aggregateSourceValueMinor` reads — its id and its
 *  current value in minor units (the `ManualAsset` rows the ajustes tile has). */
export interface SourceValueAsset {
  id: string;
  currentValue: { amountMinor: number };
}

/**
 * Sum the current value (minor units) of the assets that belong to a connected
 * source (PRD #245/#248): a source now materializes ONE asset per occupied rung
 * (market + term-locked), so the ajustes tile shows Σ over those rung assets. Pure
 * so the tile stays thin glue and the cross-rung aggregation is unit-testable.
 */
export function aggregateSourceValueMinor(
  assets: readonly SourceValueAsset[],
  assetIds: ReadonlySet<string>,
): number {
  return assets
    .filter((a) => assetIds.has(a.id))
    .reduce((sum, a) => sum + a.currentValue.amountMinor, 0);
}
