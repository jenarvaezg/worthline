import type { InvestmentPriceProvider } from "@worthline/domain";

import { resolveFinectPlan } from "./finect";

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

/**
 * A Finect pension-plan slug looks like `<DGS code>-<Manager>`, e.g.
 * `N5394-Myinvestor`. Finect has no server-queryable search API, so the only
 * supported Finect lookup is confirming a pasted slug resolves to a real plan.
 */
function looksLikeFinectSlug(query: string): boolean {
  return /^[A-Za-z]?\d{3,}-[A-Za-z0-9-]+$/.test(query.trim());
}

async function resolveFinectCandidate(query: string): Promise<SymbolCandidate | null> {
  try {
    const plan = await resolveFinectPlan(query.trim());
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
 * Search across providers for symbols matching a name, ISIN, or Finect slug.
 *
 * - Yahoo handles free-text and ISIN search for funds, ETFs, stocks, indices.
 * - Finect has no search API; when the query looks like a plan slug it is
 *   resolved directly and surfaced (confirmed by its live NAV) at the top.
 *
 * Never throws: each provider degrades independently to no results.
 */
export async function searchSymbols(query: string): Promise<SymbolCandidate[]> {
  const [yahoo, finect] = await Promise.all([
    searchYahooSymbols(query),
    looksLikeFinectSlug(query) ? resolveFinectCandidate(query) : Promise.resolve(null),
  ]);

  return finect ? [finect, ...yahoo] : yahoo;
}
