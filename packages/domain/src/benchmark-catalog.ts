/**
 * Shared benchmark series catalog (ADR 0060, #625). Market-index entries are
 * keyed by the exposure profile's `trackedIndex` label; resolving a label to a
 * `series_id` is identity lookup — never fuzzy text-matching. Each index ships
 * both variants Yahoo provides free: total-return (accumulating-ETF NAV proxy,
 * EUR-listed where possible) and price-only (the underlying index, or a
 * distributing ETF where the index itself is not quoted).
 *
 * Every symbol here was verified against Yahoo's monthly chart endpoint while
 * retiring Stooq on 2026-07-31 (#1354) — all ten answered with 103–121 monthly
 * points over ten years. A symbol must return a real multi-year series, not one
 * point (and `fetchYahooMonthlyBenchmark` now THROWS on an unknown symbol, so a
 * mistyped one shows up as a reported failure rather than an empty series).
 *
 * The Stooq symbols did not map one-to-one. `^MXWO` (MSCI World) is unknown to
 * Yahoo, `^ACWI` answers with a single point, and `isac.de` does not exist there —
 * so those price variants ride the index's DISTRIBUTING ETF (`URTH`, `ACWI`) and
 * the ACWI total-return rides its EUR-listed accumulating share class (`IUSQ.DE`,
 * the same fund as ISAC). A distributing ETF is in fact the honest price-only
 * analogue for a distributing holding's TWR. Each coverage note says which
 * instrument it really is; a benchmark never pretends to be something it is not
 * (ADR 0060).
 */

export type BenchmarkVariant = "total_return" | "price";

export interface BenchmarkCatalogEntry {
  seriesId: string;
  /** The `trackedIndex` label from the exposure catalog (ADR 0039). */
  trackedIndex: string;
  variant: BenchmarkVariant;
  /** Yahoo provider symbol for the monthly history fetch (#1354). */
  yahooSymbol: string;
  /** Shown beside the comparison — honesty about coverage / FX. */
  coverageNote: string;
}

export const BENCHMARK_CATALOG: readonly BenchmarkCatalogEntry[] = [
  {
    seriesId: "sp500-tr",
    trackedIndex: "S&P 500",
    variant: "total_return",
    yahooSymbol: "SXR8.DE",
    coverageNote: "Rentabilidad total (ETF acumulador EUR, SXR8).",
  },
  {
    seriesId: "sp500-price",
    trackedIndex: "S&P 500",
    variant: "price",
    yahooSymbol: "^GSPC",
    coverageNote: "Índice de precio (USD, sin dividendos).",
  },
  {
    seriesId: "msci-world-tr",
    trackedIndex: "MSCI World",
    variant: "total_return",
    yahooSymbol: "EUNL.DE",
    coverageNote: "Rentabilidad total (ETF acumulador EUR, EUNL).",
  },
  {
    seriesId: "msci-world-price",
    trackedIndex: "MSCI World",
    variant: "price",
    yahooSymbol: "URTH",
    coverageNote: "Precio del ETF de reparto MSCI World (USD, sin dividendos).",
  },
  {
    seriesId: "msci-acwi-tr",
    trackedIndex: "MSCI ACWI",
    variant: "total_return",
    yahooSymbol: "IUSQ.DE",
    coverageNote: "Rentabilidad total (ETF acumulador EUR, IUSQ).",
  },
  {
    seriesId: "msci-acwi-price",
    trackedIndex: "MSCI ACWI",
    variant: "price",
    yahooSymbol: "ACWI",
    coverageNote: "Precio del ETF de reparto MSCI ACWI (USD, sin dividendos).",
  },
  {
    seriesId: "nasdaq-100-tr",
    trackedIndex: "Nasdaq-100",
    variant: "total_return",
    yahooSymbol: "EQQQ.DE",
    coverageNote: "Rentabilidad total (ETF acumulador EUR, EQQQ).",
  },
  {
    seriesId: "nasdaq-100-price",
    trackedIndex: "Nasdaq-100",
    variant: "price",
    yahooSymbol: "^NDX",
    coverageNote: "Índice de precio (USD, sin dividendos).",
  },
  {
    seriesId: "gold-tr",
    trackedIndex: "Gold",
    variant: "total_return",
    yahooSymbol: "4GLD.DE",
    coverageNote: "Rentabilidad total (ETC oro físico EUR, 4GLD).",
  },
  {
    seriesId: "gold-price",
    trackedIndex: "Gold",
    variant: "price",
    yahooSymbol: "GC=F",
    coverageNote: "Futuro de oro del mes próximo (USD/oz, sin carry).",
  },
] as const;

const catalogBySeriesId = new Map(
  BENCHMARK_CATALOG.map((entry) => [entry.seriesId, entry]),
);

/** Every market-index `series_id` the cron should backfill. */
export function listMarketIndexSeriesIds(): string[] {
  return BENCHMARK_CATALOG.map((entry) => entry.seriesId);
}

/** Catalog entry for a `series_id`, or undefined when unknown. */
export function benchmarkCatalogEntryBySeriesId(
  seriesId: string,
): BenchmarkCatalogEntry | undefined {
  return catalogBySeriesId.get(seriesId);
}

/** Tracked-index labels offered in the exposure-profile picker. */
export function listTrackedIndexLabels(): string[] {
  const labels = new Set<string>();
  for (const entry of BENCHMARK_CATALOG) {
    labels.add(entry.trackedIndex);
  }
  return [...labels].sort((left, right) => left.localeCompare(right));
}

/**
 * Resolve a `trackedIndex` label to the catalog `series_id`. Accumulating
 * holdings (default) compare vs total-return; distributing holdings compare vs
 * the price index because TWR tracks price only (ADR 0040).
 */
export function resolveBenchmarkSeriesId(
  trackedIndex: string | null | undefined,
  distributing: boolean,
): string | null {
  const label = trackedIndex?.trim();
  if (!label) return null;

  const variant: BenchmarkVariant = distributing ? "price" : "total_return";
  const entry = BENCHMARK_CATALOG.find(
    (candidate) => candidate.trackedIndex === label && candidate.variant === variant,
  );
  return entry?.seriesId ?? null;
}

/** Coverage note for a resolved series, or null when the series is unknown. */
export function benchmarkCoverageNote(seriesId: string): string | null {
  return catalogBySeriesId.get(seriesId)?.coverageNote ?? null;
}
