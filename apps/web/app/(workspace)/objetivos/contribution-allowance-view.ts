import type {
  ContributionAllowance,
  ContributionAllowanceEntry,
  ContributionAllowanceUsage,
  ManualAsset,
} from "@worthline/domain";
import { keepsAnOperationLedger } from "@worthline/domain";

/**
 * View model for the annual contribution allowance panel (#1427).
 *
 * The arithmetic lives in the domain (`computeContributionAllowanceUsage`); this
 * module only turns one allowance and its usage into everything the panel paints,
 * so the JSX resolves nothing for itself and cannot re-derive a figure a second
 * way. Pure and tested, so the rule that decides "te has pasado" is not buried in
 * markup.
 */

export type ContributionAllowanceTone = "ok" | "exceeded";

export interface ContributionAllowanceRowView {
  allowance: ContributionAllowance;
  label: string;
  year: number;
  capMinor: number;
  consumedMinor: number;
  /** `cap − consumed`, signed: negative once the cap is exceeded. */
  remainingMinor: number;
  /** The amount to print after the "quedan"/"excedido" word — always ≥ 0. */
  remainderAmountMinor: number;
  /** `quedan` while there is room, `excedido` once there is not. */
  remainderWord: "quedan" | "excedido";
  /** Bar fill, clamped to 0–100 — an overshoot fills it, it does not overflow it. */
  barPercent: number;
  tone: ContributionAllowanceTone;
  /** Names of the destinations that consume this allowance, in the stored order. */
  destinationNames: string[];
  /** Marked destinations whose holding is not on this page — their entries are unseen. */
  unknownDestinationCount: number;
  /** In-year entries not counted because they are denominated elsewhere (#1401). */
  skippedForeignCount: number;
  /** The counted entries, most recent first — the audit trail of the figure. */
  entries: ContributionAllowanceEntry[];
}

export function contributionAllowanceRowView(input: {
  allowance: ContributionAllowance;
  usage: ContributionAllowanceUsage;
  holdingNameById: ReadonlyMap<string, string>;
}): ContributionAllowanceRowView {
  const { allowance, holdingNameById, usage } = input;
  const ratio = usage.consumedRatio ?? 0;

  const destinationNames: string[] = [];
  let unknownDestinationCount = 0;
  for (const holdingId of allowance.holdingIds) {
    const name = holdingNameById.get(holdingId);
    if (name === undefined) {
      unknownDestinationCount += 1;
      continue;
    }
    destinationNames.push(name);
  }

  return {
    allowance,
    barPercent: Math.max(0, Math.min(100, ratio * 100)),
    capMinor: usage.capMinor,
    consumedMinor: usage.consumedMinor,
    destinationNames,
    entries: usage.entries,
    label: allowance.label,
    remainderAmountMinor: Math.abs(usage.remainingMinor),
    remainderWord: usage.remainingMinor < 0 ? "excedido" : "quedan",
    remainingMinor: usage.remainingMinor,
    skippedForeignCount: usage.skippedForeignCount,
    // Two tones, not three: an "almost there" threshold would be a number nobody
    // declared, and #1427 defers the over-cap warning to data quality (PRD #654).
    // The bar filling up is the approach; the printed line is the truth.
    tone: usage.exceeded ? "exceeded" : "ok",
    unknownDestinationCount,
    year: usage.year,
  };
}

/**
 * The holdings a cupo may point at: those with an **operation ledger**
 * (`keepsAnOperationLedger`, the same predicate the store enforces at the door).
 *
 * A cupo counts real entries, and a stored-value or connected-source holding
 * records none it could count — a cupo over one would read "0 € de 1.500 €", the
 * counter lying downwards, which is exactly the failure this feature exists to
 * prevent. Not offered at all, rather than offered and wrong.
 */
export function contributionAllowanceDestinationOptions(
  assets: readonly ManualAsset[],
): ManualAsset[] {
  return assets.filter(keepsAnOperationLedger);
}
