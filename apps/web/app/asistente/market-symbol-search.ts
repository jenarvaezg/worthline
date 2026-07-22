/**
 * Market-symbol resolution for the assistant alta flow (#1186). A holding of an
 * investment instrument is repriced by `pricePairKey(priceProvider, providerSymbol)`
 * — `refresh-stale-prices` and the daily capture DROP any asset without a
 * `providerSymbol` — so the ISIN alone never keeps a chat-created fund/ETF fresh.
 *
 * This wraps the wizard's own {@link searchSymbols} (Yahoo for fund/etf/stock/index,
 * CoinGecko for crypto, Finect for pension plans) so the model can resolve a real
 * symbol with a tool and the user confirms it in the alta preview before applying.
 * Kept as a pure, network-degrading module so the tool wiring and the shaping are
 * testable without hitting a live provider.
 */

import type { Instrument } from "@worthline/domain";
import { type SymbolCandidate, searchSymbols } from "@worthline/pricing";

/** Cap the candidate list the model sees so a broad name search stays legible. */
const MAX_MARKET_SYMBOL_MATCHES = 8;

/**
 * The market instruments this symbol search resolves (#1186 AC1): funds/ETFs/
 * stocks/indices via Yahoo, crypto via CoinGecko. Pension plans price off a
 * Finect NAV that the wizard's Finect flow already resolves and are out of this
 * tool's scope; an investment alta of any family still gets the price-tracking
 * warning when it lacks a symbol (see `priceTrackingWarningOf`).
 */
export const MARKET_INSTRUMENTS: ReadonlySet<Instrument> = new Set<Instrument>([
  "fund",
  "etf",
  "stock",
  "index",
  "crypto",
]);

/** Whether this tool resolves a price symbol for the instrument (and routes it). */
export function isMarketInstrument(instrument: Instrument | undefined | null): boolean {
  return instrument != null && MARKET_INSTRUMENTS.has(instrument);
}

/**
 * One symbol candidate reshaped for the chat: the `symbol` is exactly what goes
 * into `propose_holding.providerSymbol`; `market`/`currency` disambiguate the
 * listing (the exchange suffix matters — `VUSA.L` ≠ `VUSA.AS`).
 */
export interface MarketSymbolMatch {
  provider: string;
  symbol: string;
  name: string;
  market?: string;
  currency?: string;
  quoteType?: string;
}

export function shapeMarketSymbolMatch(candidate: SymbolCandidate): MarketSymbolMatch {
  return {
    name: candidate.name,
    provider: candidate.provider,
    symbol: candidate.symbol,
    ...(candidate.exchange ? { market: candidate.exchange } : {}),
    ...(candidate.currency ? { currency: candidate.currency } : {}),
    ...(candidate.quoteType ? { quoteType: candidate.quoteType } : {}),
  };
}

/**
 * Resolve a name/ISIN into ranked, deduped market-symbol candidates, routed by
 * instrument through {@link searchSymbols}. A blank query short-circuits (no
 * network); an unknown/non-market instrument routes as the mixed legacy search.
 * Never throws: `searchSymbols` already degrades to no results.
 */
export async function resolveMarketSymbolCandidates(
  query: string,
  instrument?: string,
): Promise<MarketSymbolMatch[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const routed = isMarketInstrument(instrument as Instrument | undefined)
    ? (instrument as Instrument)
    : undefined;

  const candidates = await searchSymbols(trimmed, routed);
  return candidates.slice(0, MAX_MARKET_SYMBOL_MATCHES).map(shapeMarketSymbolMatch);
}
