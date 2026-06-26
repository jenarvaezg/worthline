import type { Instrument, InvestmentPriceProvider } from "@worthline/domain";

import { coingeckoBaseUrl } from "./coingecko";
import { resolveFinectPlan, resolveFinectPlanSymbolByCode } from "./finect";

/**
 * A symbol-search hit: a provider + symbol pair ready to fill an investment's
 * price configuration, plus display metadata to help the user pick the right
 * one (a single ISIN can map to several exchange listings and a NAV symbol).
 */
export interface SymbolCandidate {
  provider: InvestmentPriceProvider;
  symbol: string;
  name: string;
  exchange?: string;
  quoteType?: string;
  currency?: string;
}

const YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";

/** Quote types worth offering as investments — funds, ETFs, stocks, indices. */
const RELEVANT_QUOTE_TYPES = new Set(["EQUITY", "ETF", "MUTUALFUND", "INDEX"]);

interface YahooSearchResponse {
  quotes?: Array<{
    symbol?: string;
    shortname?: string;
    longname?: string;
    exchange?: string;
    exchDisp?: string;
    quoteType?: string;
  }>;
}

/**
 * Search Yahoo Finance by free text or ISIN. Yahoo resolves an ISIN to its
 * listed symbols (including the `0P…` daily-NAV symbol for funds), so a user
 * can paste the ISIN from their broker and pick the right hit.
 *
 * Never throws: a network error or non-OK response degrades to no results.
 */
export async function searchYahooSymbols(query: string): Promise<SymbolCandidate[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    const url =
      `${YAHOO_SEARCH_URL}?q=${encodeURIComponent(trimmed)}` +
      "&quotesCount=10&newsCount=0";
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return [];

    const data = (await res.json()) as YahooSearchResponse;

    return (data.quotes ?? [])
      .filter((q) => q.symbol && (!q.quoteType || RELEVANT_QUOTE_TYPES.has(q.quoteType)))
      .map((q) => ({
        provider: "yahoo" as const,
        symbol: q.symbol!,
        name: q.longname ?? q.shortname ?? q.symbol!,
        ...((q.exchDisp ?? q.exchange) ? { exchange: q.exchDisp ?? q.exchange } : {}),
        ...(q.quoteType ? { quoteType: q.quoteType } : {}),
      }));
  } catch {
    return [];
  }
}

interface CoinGeckoSearchResponse {
  coins?: Array<{
    id?: string;
    name?: string;
    symbol?: string;
  }>;
}

/**
 * Search CoinGecko's coin index by name or ticker. Crypto is priced by the
 * CoinGecko provider keyed on the lowercase coin **id** (e.g. `bitcoin`), so the
 * candidate's `symbol` is that id — not the exchange ticker — letting the alta
 * flow store exactly what the price fetch keys on. The ticker (BTC) is surfaced
 * as display metadata. Goes through `coingeckoBaseUrl()` so a test/e2e stub can
 * redirect it.
 *
 * Never throws: a network error or non-OK response degrades to no results.
 */
export async function searchCoinGeckoSymbols(query: string): Promise<SymbolCandidate[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    const url = `${coingeckoBaseUrl()}/search?query=${encodeURIComponent(trimmed)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });

    if (!res.ok) return [];

    const data = (await res.json()) as CoinGeckoSearchResponse;

    return (data.coins ?? [])
      .filter((c) => c.id)
      .map((c) => ({
        provider: "coingecko" as const,
        symbol: c.id!,
        name: c.name ?? c.id!,
        quoteType: "CRYPTOCURRENCY",
        ...(c.symbol ? { exchange: c.symbol } : {}),
      }));
  } catch {
    return [];
  }
}

/**
 * A Finect pension-plan slug looks like `<DGS code>-<slug>`, e.g.
 * `N5394-Myinvestor_indexado_sp_500_pp`; a bare DGS code like `N5394` needs an
 * API lookup before the public sheet URL can be validated.
 */
function finectSymbolFromQuery(
  query: string,
): { kind: "code" | "slug"; value: string } | null {
  let candidate = query.trim();

  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    if (!/(^|\.)finect\.com$/i.test(url.hostname)) return null;
    candidate = url.pathname;
  } catch {
    // Not a URL; treat it as a raw slug or copied path.
  }

  const marker = "/planes-pensiones/";
  const markerIndex = candidate.toLowerCase().indexOf(marker);
  if (markerIndex >= 0) {
    candidate = candidate.slice(markerIndex + marker.length);
  }

  const slug = (decodeURIComponent(candidate).split(/[?#]/, 1)[0] ?? "").replace(
    /^\/+|\/+$/g,
    "",
  );

  if (/^[A-Za-z]?\d{3,}-[A-Za-z0-9_-]+$/.test(slug)) {
    return { kind: "slug", value: slug };
  }

  if (/^[A-Za-z]?\d{3,}$/.test(slug)) {
    return { kind: "code", value: slug };
  }

  return null;
}

async function resolveFinectCandidate(query: string): Promise<SymbolCandidate | null> {
  try {
    const lookup = finectSymbolFromQuery(query);
    if (!lookup) return null;

    const symbol =
      lookup.kind === "code"
        ? await resolveFinectPlanSymbolByCode(lookup.value)
        : lookup.value;
    if (!symbol) return null;

    const plan = await resolveFinectPlan(symbol);
    if (!plan) return null;

    return {
      provider: "finect",
      symbol: plan.symbol,
      name: plan.name,
      currency: "EUR",
      quoteType: "PENSIONPLAN",
    };
  } catch {
    return null;
  }
}

/**
 * Search for symbols matching a name, ISIN, or Finect slug, routed by the
 * selected instrument so each holding sees only its provider's hits (#304):
 *
 * - `crypto` → CoinGecko only (native coins; suppresses Yahoo equity/ETF noise).
 * - `pension_plan` → Finect only (a slug resolved against its live NAV).
 * - `fund`/`etf`/`stock`/`index` → Yahoo only (free-text and ISIN search).
 * - no/unknown instrument → Yahoo + Finect-slug, the legacy mixed behaviour.
 *
 * Never throws: each provider degrades independently to no results.
 */
export async function searchSymbols(
  query: string,
  instrument?: Instrument,
): Promise<SymbolCandidate[]> {
  if (instrument === "crypto") {
    return searchCoinGeckoSymbols(query);
  }

  if (instrument === "pension_plan") {
    const finect = await resolveFinectCandidate(query);
    return finect ? [finect] : [];
  }

  if (
    instrument === "fund" ||
    instrument === "etf" ||
    instrument === "stock" ||
    instrument === "index"
  ) {
    return searchYahooSymbols(query);
  }

  const [yahoo, finect] = await Promise.all([
    searchYahooSymbols(query),
    resolveFinectCandidate(query),
  ]);

  return finect ? [finect, ...yahoo] : yahoo;
}
