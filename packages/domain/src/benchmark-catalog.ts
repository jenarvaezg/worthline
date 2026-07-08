/**
 * Shared benchmark series catalog (ADR 0060, #625). Market-index entries are
 * keyed by the exposure profile's `trackedIndex` label; resolving a label to a
 * `series_id` is identity lookup — never fuzzy text-matching. Each index ships
 * both variants where Stooq provides them free: total-return (accumulating-ETF
 * NAV proxy, EUR-listed where possible) and price-only (the underlying index).
 */

export type BenchmarkVariant = "total_return" | "price";

export interface BenchmarkCatalogEntry {
  seriesId: string;
  /** The `trackedIndex` label from the exposure catalog (ADR 0039). */
  trackedIndex: string;
  variant: BenchmarkVariant;
  /** Stooq provider symbol for monthly history fetch. */
  stooqSymbol: string;
  /** Shown beside the comparison — honesty about coverage / FX. */
  coverageNote: string;
}

export const BENCHMARK_CATALOG: readonly BenchmarkCatalogEntry[] = [
  {
    seriesId: "sp500-tr",
    trackedIndex: "S&P 500",
    variant: "total_return",
    stooqSymbol: "sxr8.de",
    coverageNote: "Rentabilidad total (ETF acumulador EUR, SXR8).",
  },
  {
    seriesId: "sp500-price",
    trackedIndex: "S&P 500",
    variant: "price",
    stooqSymbol: "^spx",
    coverageNote: "Índice de precio (USD, sin dividendos).",
  },
  {
    seriesId: "msci-world-tr",
    trackedIndex: "MSCI World",
    variant: "total_return",
    stooqSymbol: "eunl.de",
    coverageNote: "Rentabilidad total (ETF acumulador EUR, EUNL).",
  },
  {
    seriesId: "msci-world-price",
    trackedIndex: "MSCI World",
    variant: "price",
    stooqSymbol: "^mxwo",
    coverageNote: "Índice de precio (USD, sin dividendos).",
  },
  {
    seriesId: "msci-acwi-tr",
    trackedIndex: "MSCI ACWI",
    variant: "total_return",
    stooqSymbol: "isac.de",
    coverageNote: "Rentabilidad total (ETF acumulador EUR, ISAC).",
  },
  {
    seriesId: "msci-acwi-price",
    trackedIndex: "MSCI ACWI",
    variant: "price",
    stooqSymbol: "^acwi",
    coverageNote: "Índice de precio (USD, sin dividendos).",
  },
  {
    seriesId: "nasdaq-100-tr",
    trackedIndex: "Nasdaq-100",
    variant: "total_return",
    stooqSymbol: "eqqq.de",
    coverageNote: "Rentabilidad total (ETF acumulador EUR, EQQQ).",
  },
  {
    seriesId: "nasdaq-100-price",
    trackedIndex: "Nasdaq-100",
    variant: "price",
    stooqSymbol: "^ndx",
    coverageNote: "Índice de precio (USD, sin dividendos).",
  },
  {
    seriesId: "gold-tr",
    trackedIndex: "Gold",
    variant: "total_return",
    stooqSymbol: "4gld.de",
    coverageNote: "Rentabilidad total (ETC oro físico EUR, 4GLD).",
  },
  {
    seriesId: "gold-price",
    trackedIndex: "Gold",
    variant: "price",
    stooqSymbol: "xauusd",
    coverageNote: "Spot oro (USD/oz, sin carry).",
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
