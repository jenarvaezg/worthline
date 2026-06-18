/**
 * The connected-source adapter registry (ADR 0027, #319).
 *
 * Maps the persisted `SourceAdapter` tag → the adapter object that owns that
 * provider's behaviour. Code stops re-branching on the tag (the old
 * `instrumentForAdapter`/`frozenInstrumentForAdapter`/action `=== "numista"`
 * switches): it looks the adapter up here once and dispatches.
 *
 * #319 fully migrates Numista. The Binance entry is a minimal SHIM (instrument /
 * suffix metadata + `classifyRung`) so the provider-agnostic store can resolve a
 * Binance row's metadata off an adapter without changing Binance behaviour — #322
 * folds Binance's real lifecycle into its adapter.
 */

import type { Instrument, LiquidityTier, SourceAdapter } from "@worthline/domain";

import { binanceAdapter } from "./binance";
import { numistaAdapter } from "./numista";
import type { PositionDraft } from "./types";

/**
 * The provider metadata + classification the generic store reads off an adapter —
 * the variance-free subset (no `Creds`/`Token`), so the registry can erase each
 * adapter's credential generics behind one common, store-facing shape (ADR 0027).
 */
export interface SourceAdapterMetadata {
  readonly tag: SourceAdapter;
  readonly liveInstrument: Instrument;
  readonly frozenInstrument: Instrument;
  readonly termLockedSuffix: string | null;
  classifyRung(position: PositionDraft): LiquidityTier;
}

/** Every registered adapter, keyed by its persisted tag (the strongly-typed
 *  adapters are imported directly by the lifecycle, which knows each concrete
 *  credential type; the store consumes them through {@link adapterForTag}'s
 *  metadata view). */
const connectedSourceAdapters: Record<SourceAdapter, SourceAdapterMetadata> = {
  numista: numistaAdapter,
  binance: binanceAdapter,
};

/** Resolve the store-facing metadata for a persisted source tag. The mapping is
 *  total over the `SourceAdapter` union, so the lookup never returns undefined. */
export function adapterForTag(tag: SourceAdapter): SourceAdapterMetadata {
  return connectedSourceAdapters[tag];
}
