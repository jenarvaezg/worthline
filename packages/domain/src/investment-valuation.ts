import type { CostBasisGrade } from "./cost-basis-grade";
import type { DecimalString } from "./decimal";
import { isPositiveDecimal } from "./decimal";
import type { DomainViolation } from "./domain-result";
import type { InvestmentOperation, PositionWarning } from "./investment-types";
import { derivePosition } from "./positions";
import type { AssetPrice, PriceSource } from "./prices";
import type { ManualAsset } from "./workspace-types";

/**
 * Guard: throws a domain error if `asset` is of type "investment".
 *
 * Call this at the top of any code path that would manually set an asset's
 * stored value — an investment's value is always derived (units × price) and
 * must never be edited by hand (ADR 0006).
 */
export function assertNotInvestmentAsset(asset: ManualAsset): void {
  if (asset.type === "investment") {
    throw new Error(
      `Cannot manually set the valuation of investment asset "${asset.name}" (id: ${asset.id}). ` +
        "An investment's value is always derived from its units and unit price. " +
        "Record an operation or update the price instead.",
    );
  }
}

/**
 * Guard: throws a domain error if `asset` is materialized from a connected source.
 *
 * Call this at the top of any code path that would manually set an asset's
 * stored value — a connected holding's value is always re-rolled by its source
 * sync and must never be edited by hand (#883, #945).
 */
export function assertNotConnectedValuation(asset: ManualAsset): void {
  if (asset.connectedSourceId != null) {
    throw new Error(
      `Cannot manually set the valuation of connected asset "${asset.name}" (id: ${asset.id}). ` +
        "A connected holding's value is always derived from its source sync.",
    );
  }
}

/**
 * Non-throwing check for manual valuation guards. Returns the first violation
 * that would block a hand-set value/operation/anchor, or null when allowed.
 */
export function checkManualValuationViolation(
  asset: ManualAsset,
): DomainViolation | null {
  if (asset.type === "investment") {
    return { code: "investment_manual_valuation_rejected" };
  }
  if (asset.connectedSourceId != null) {
    return { code: "connected_manual_valuation_rejected" };
  }
  return null;
}

/** Assert every manual-valuation guard passes; throws on the first violation. */
export function assertManualValuationAllowed(asset: ManualAsset): void {
  assertNotInvestmentAsset(asset);
  assertNotConnectedValuation(asset);
}

/** The price source selected by the price-selection rule. */
export type InvestmentPriceSource = "cached" | "manual";

/** Result of the price-selection rule. */
export interface SelectedInvestmentPrice {
  pricePerUnit: DecimalString;
  source: InvestmentPriceSource;
}

/**
 * Price-selection rule (ADR 0006): cached provider price beats a manual quote.
 * Returns undefined when neither is available.
 *
 * A non-positive (or malformed) figure is not a price and is skipped: the price
 * pool writes `price: "0"` as the marker of a failed fetch with no prior good
 * price, and consuming that zero valued live holdings at 0 € (#1330). Falling
 * through leaves the valuation on its cost-basis fallback, the same answer as
 * "no row at all" (#1314).
 */
export function selectInvestmentPrice(input: {
  cachedPrice: DecimalString | undefined;
  manualPrice: DecimalString | undefined;
}): SelectedInvestmentPrice | undefined {
  if (input.cachedPrice !== undefined && isPositiveDecimal(input.cachedPrice)) {
    return { pricePerUnit: input.cachedPrice, source: "cached" };
  }
  if (input.manualPrice !== undefined && isPositiveDecimal(input.manualPrice)) {
    return { pricePerUnit: input.manualPrice, source: "manual" };
  }
  return undefined;
}

/**
 * Where the price that values an investment comes from, and of when (#1828).
 *
 * The three answers the selection rule can give (ADR 0006) and nothing else: a
 * provider's cached quote, the price someone set by hand, or no price at all —
 * valued at what it cost. «The last operation's price» is NOT one of them: the
 * live rule never reads the ledger's prices, and a hand-set price that happens to
 * equal the last purchase is still a hand-set price. `asOf` is the day the price
 * is FROM, and null when nothing the app stored can say it — a hand-set price saved
 * before every change was stamped has none (the v72 rung cleared those stamps).
 *
 * `refreshFailed` says the provider's last refresh of this holding failed (#1731
 * review), whichever price was picked: a quote is then the one kept from before the
 * failure, and a hand-set price or the cost stands in for a quote that never came.
 * Without it a failed refresh was invisible — the day alone cannot say it, because a
 * kept quote often has no market day to show.
 */
export type InvestmentPriceOrigin =
  | {
      kind: "quote";
      provider: PriceSource | null;
      asOf: string | null;
      refreshFailed: boolean;
    }
  | { kind: "manual"; asOf: string | null; refreshFailed: boolean }
  | { kind: "cost"; refreshFailed: boolean };

/**
 * What the cache row says about the price it carries — the provenance riding next
 * to `cachedPrice`, never a second copy of the figure.
 */
export type CachedQuoteProvenance = Pick<
  AssetPrice,
  "source" | "priceDate" | "fetchedAt" | "freshnessState"
>;

/** Inputs for a single investment's derived valuation. */
export interface DeriveInvestmentValuationInput {
  assetId: string;
  currency: string;
  operations: InvestmentOperation[];
  cachedPrice: DecimalString | undefined;
  manualPrice: DecimalString | undefined;
  /** The cache row behind `cachedPrice`: who quoted it and of when (#1828). */
  cachedQuote?: CachedQuoteProvenance;
  /** When `manualPrice` was set (an ISO instant), when the app knows it (#1828). */
  manualPricedAt?: string;
}

/**
 * The day a cached quote is FROM. The market day the provider reported wins; a
 * fresh row without one was fetched live, so its fetch is its moment. A row kept
 * after a failed refresh carries the failed attempt's time (#730), so without a
 * market day it has no date to give.
 */
function quoteAsOf(quote: CachedQuoteProvenance | undefined): string | null {
  if (quote?.priceDate) return quote.priceDate.slice(0, 10);
  if (quote?.freshnessState === "fresh") return quote.fetchedAt.slice(0, 10);
  return null;
}

/**
 * Whether the provider's last refresh failed: the pool marks a kept price `stale`
 * and a failure with nothing to keep `failed` (#730, #1330).
 */
function lastRefreshFailed(quote: CachedQuoteProvenance | undefined): boolean {
  return quote?.freshnessState === "stale" || quote?.freshnessState === "failed";
}

/** The origin of the price the rule picked — read off the pick, never re-derived. */
function priceOriginOf(
  selected: SelectedInvestmentPrice | undefined,
  input: DeriveInvestmentValuationInput,
): InvestmentPriceOrigin {
  const refreshFailed = lastRefreshFailed(input.cachedQuote);
  if (selected === undefined) return { kind: "cost", refreshFailed };
  if (selected.source === "manual") {
    return {
      asOf: input.manualPricedAt?.slice(0, 10) ?? null,
      kind: "manual",
      refreshFailed,
    };
  }
  // A quote with no provenance handed in is still a quote; who quoted it is unknown.
  return {
    asOf: quoteAsOf(input.cachedQuote),
    kind: "quote",
    provider: input.cachedQuote?.source ?? null,
    refreshFailed,
  };
}

/** The derived valuation of one investment. */
export interface InvestmentValuation {
  /** The current value in integer minor units (market value if price known, else cost basis). */
  valueMinor: number;
  /** The price per unit used to derive market value, if any. */
  pricePerUnit: DecimalString | undefined;
  /** Which source supplied the price, if any. */
  priceSource: InvestmentPriceSource | undefined;
  /**
   * Where that price comes from and of when (#1828), out of the SAME pick that
   * valued the holding — so a surface that prints «cotización Yahoo · 11/10/2026»
   * beside the value is quoting the rule, not guessing at it afterwards.
   */
  priceOrigin: InvestmentPriceOrigin;
  /** Coded clamps raised during position derivation (e.g. oversell). */
  warnings: PositionWarning[];
  /**
   * How honest the cost this position is measured against is (#1505), straight
   * off the fold. It rides here rather than being re-derived by each reader for
   * the same reason the warnings do: this is the single authority for what an
   * investment is worth, and «worth 5.865,75 €» and «that is also what it cost»
   * are two claims that must not come from two engines (#1422).
   */
  costBasisGrade?: CostBasisGrade;
}

/**
 * The single authority for "what is this investment worth" (ADR 0006).
 *
 * Applies the price-selection rule (cached beats manual), delegates position
 * math to `derivePosition`, and returns the value in minor units together with
 * the price used and any derivation warnings.
 *
 * When no price is available the value falls back to the cost basis so the
 * investment is never silently valued at zero before any price is known.
 */
export function deriveInvestmentValuation(
  input: DeriveInvestmentValuationInput,
): InvestmentValuation {
  const selected = selectInvestmentPrice({
    cachedPrice: input.cachedPrice,
    manualPrice: input.manualPrice,
  });

  const position = derivePosition(input.operations, {
    assetId: input.assetId,
    currency: input.currency,
    ...(selected ? { currentPricePerUnit: selected.pricePerUnit } : {}),
  });

  return {
    ...(position.costBasisGrade === undefined
      ? {}
      : { costBasisGrade: position.costBasisGrade }),
    priceOrigin: priceOriginOf(selected, input),
    pricePerUnit: selected?.pricePerUnit,
    priceSource: selected?.source,
    valueMinor: position.marketValue?.amountMinor ?? position.costBasis.amountMinor,
    warnings: position.warnings,
  };
}
