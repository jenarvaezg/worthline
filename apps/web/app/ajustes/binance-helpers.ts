/**
 * Pure helpers for the Binance connected-source TILE (PRD #245/#248, ADR 0021).
 * Kept free of Next.js, the store, and the network so the ajustes tile stays thin
 * glue and the cross-rung value aggregation is unit-testable.
 *
 * Credential shaping/read-back is explicit Binance glue (ADR 0043). Ownership
 * resolution and last-sync formatting are generic leaf helpers, so they are
 * re-exported from numista-helpers.
 */

import type { SourcePosition, TokenPosition } from "@worthline/domain";
import { groupPositionsByToken, isTokenDustValue } from "@worthline/domain";
import type { BinanceCredentials } from "@worthline/pricing";

export { formatLastSync, resolveConnectingOwnership } from "./numista-helpers";

export function parseBinanceCredentials(
  apiKey: FormDataEntryValue | null,
  apiSecret: FormDataEntryValue | null,
): BinanceCredentials | null {
  const key = String(apiKey ?? "").trim();
  const secret = String(apiSecret ?? "").trim();
  return key && secret ? { apiKey: key, apiSecret: secret } : null;
}

export function serializeBinanceCredentials(creds: BinanceCredentials): string {
  return JSON.stringify({ apiKey: creds.apiKey, apiSecret: creds.apiSecret });
}

export function readBinanceCredentials(
  credentialsJson: string,
): BinanceCredentials | null {
  try {
    const parsed = JSON.parse(credentialsJson) as {
      apiKey?: unknown;
      apiSecret?: unknown;
    };
    return parseBinanceCredentials(
      typeof parsed.apiKey === "string" ? parsed.apiKey : null,
      typeof parsed.apiSecret === "string" ? parsed.apiSecret : null,
    );
  } catch {
    return null;
  }
}

/**
 * Count the DISTINCT non-dust tokens a Binance source holds (#479): group the
 * source's token positions by symbol (a token across wallets folds into one) and
 * drop the ones whose summed value is dust — junk worth under a cent, incl.
 * unpriceable tokens. The ajustes tile shows this so the "Tokens" stat matches the
 * tokens actually worth listing. DISPLAY-ONLY: positions are never dropped from
 * storage, only excluded from the count.
 */
export function countNonDustTokens(positions: readonly SourcePosition[]): number {
  const tokens = positions.filter(
    (position): position is TokenPosition => position.kind === "token",
  );
  return groupPositionsByToken([...tokens]).filter(
    (group) => !isTokenDustValue(group.subtotalMinor),
  ).length;
}

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
