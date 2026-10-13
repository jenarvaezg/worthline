/**
 * The ficha's active warnings for one holding — ONE rule for every place that
 * prints them (#1828).
 *
 * The band above the header prints most of them; a tabbed ficha prints one or two
 * beside the figure they are about (the missing price symbol, next to the price).
 * Both read through here, so a warning can move from the band to its figure but can
 * never be in both, nor in neither: the band leaves out exactly the codes the
 * family placed, out of the same list.
 *
 * The collector reads the same closed-position filter as the board and the health
 * engine (#1348): once the position is sold out, the ficha stops asking for a price
 * symbol it no longer needs. A holding that keeps no ledger passes an empty one,
 * which `netUnitsByAsset` leaves out of the map, and absent means open.
 */

import type {
  DomainWarning,
  InvestmentOperation,
  ManualAsset,
  WarningOverride,
} from "@worthline/domain";
import { collectWarnings, netUnitsByAsset } from "@worthline/domain";

export function holdingWarnings(input: {
  asset: ManualAsset | null;
  id: string;
  operations: readonly InvestmentOperation[];
  overrides: readonly WarningOverride[];
}): DomainWarning[] {
  if (input.asset === null) return [];
  const ledger = new Map([[input.id, [...input.operations]]]);
  return collectWarnings([input.asset], [...input.overrides], {
    netUnitsByAssetId: netUnitsByAsset(ledger),
    operationsByAssetId: ledger,
  });
}

/**
 * The warnings of a holding that keeps no ledger — a stored value, a property, a
 * mirror: the band's warnings are about the holding's own row, so it passes none.
 */
export function ledgerlessHoldingWarnings(input: {
  asset: ManualAsset;
  id: string;
  overrides: readonly WarningOverride[];
}): DomainWarning[] {
  return holdingWarnings({ ...input, operations: [] });
}
