import type { DecimalString } from "./decimal";
import type { InvestmentOperation } from "./investment-types";
import type { ManualAsset } from "./workspace-types";
import { derivePosition } from "./positions";

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
 */
export function selectInvestmentPrice(input: {
  cachedPrice: DecimalString | undefined;
  manualPrice: DecimalString | undefined;
}): SelectedInvestmentPrice | undefined {
  if (input.cachedPrice !== undefined) {
    return { pricePerUnit: input.cachedPrice, source: "cached" };
  }
  if (input.manualPrice !== undefined) {
    return { pricePerUnit: input.manualPrice, source: "manual" };
  }
  return undefined;
}

/** Inputs for a single investment's derived valuation. */
export interface DeriveInvestmentValuationInput {
  assetId: string;
  currency: string;
  operations: InvestmentOperation[];
  cachedPrice: DecimalString | undefined;
  manualPrice: DecimalString | undefined;
}

/** The derived valuation of one investment. */
export interface InvestmentValuation {
  /** The current value in integer minor units (market value if price known, else cost basis). */
  valueMinor: number;
  /** The price per unit used to derive market value, if any. */
  pricePerUnit: DecimalString | undefined;
  /** Which source supplied the price, if any. */
  priceSource: InvestmentPriceSource | undefined;
  /** Any warnings raised during position derivation (e.g. oversell). */
  warnings: string[];
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
    pricePerUnit: selected?.pricePerUnit,
    priceSource: selected?.source,
    valueMinor: position.marketValue?.amountMinor ?? position.costBasis.amountMinor,
    warnings: position.warnings,
  };
}
