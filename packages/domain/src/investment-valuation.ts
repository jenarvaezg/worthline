import type { ManualAsset } from "./index";

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
