import type { FireCapitalSide, FireCapitalSplit } from "@worthline/domain";
import { LIQUIDITY_TIER_LABELS } from "@worthline/domain";

/** One printed row of the eligible-capital breakdown (#1447). */
export interface FireCapitalSplitRow {
  key: "sellable" | "immobilized";
  /** What this side is called on paper. */
  label: string;
  /** Which rungs it is made of, plus what was netted out — the audit trail in words. */
  gloss: string;
  amountMinor: number;
}

const SIDE_LABELS: Record<FireCapitalSplitRow["key"], string> = {
  immobilized: "inmovilizado",
  sellable: "vendible",
};

/**
 * Whether the eligible total is worth breaking apart (#1447). With nothing
 * immobilized there is no illusion of liquidity to undo, and two rows saying
 * "all of it is sellable" would be noise on a portfolio that is exactly that.
 */
export function shouldShowCapitalSplit(split: FireCapitalSplit): boolean {
  return split.immobilized.grossMinor > 0;
}

/**
 * The breakdown rows for `Activos elegibles`. Pure and label-only: the amounts
 * come from `splitFireCapital`, which already guarantees they add back up to
 * the eligible figure above them.
 */
export function fireCapitalSplitRows(split: FireCapitalSplit): FireCapitalSplitRow[] {
  return [
    buildRow("sellable", split.sellable),
    buildRow("immobilized", split.immobilized),
  ];
}

function buildRow(
  key: FireCapitalSplitRow["key"],
  side: FireCapitalSide,
): FireCapitalSplitRow {
  const tiers = side.tiers.map((tier) => LIQUIDITY_TIER_LABELS[tier]);
  const subtractions: string[] = [];
  if (side.debtMinor > 0) {
    subtractions.push("su deuda");
  }
  if (side.reservedMinor > 0) {
    subtractions.push("lo reservado para objetivos");
  }

  const base = tiers.length > 0 ? tiers.join(" + ") : "sin activos";
  const gloss = subtractions.length > 0 ? `${base} − ${subtractions.join(" y ")}` : base;

  return { amountMinor: side.amountMinor, gloss, key, label: SIDE_LABELS[key] };
}

/**
 * What the sellable side alone funds, as a percentage of the FIRE number — the
 * figure the single "68,5 % financiado" hides when two thirds of the pool is
 * brick. Null when there is no FIRE number to measure against.
 */
export function sellableFundedPercent(
  split: FireCapitalSplit,
  fireNumberMinor: number,
): number | null {
  if (fireNumberMinor <= 0) {
    return null;
  }
  return (split.sellable.amountMinor / fireNumberMinor) * 100;
}
