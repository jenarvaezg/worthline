import type {
  ContributionAllowance,
  ContributionAllowanceUsage,
  ManualAsset,
} from "@worthline/domain";

/**
 * View model for the annual contribution allowance panel (#1427).
 *
 * The arithmetic lives in the domain (`computeContributionAllowanceUsage`); this
 * module only turns one usage into the pieces the panel paints — bar width, tone,
 * the names of the destinations and the honesty notices. Pure and tested, so the
 * rules that decide "estás cerca del tope" are not buried in JSX.
 */

/** Share of the cap at which the counter starts warning, before it is exceeded. */
const NEAR_CAP_RATIO = 0.9;

export type ContributionAllowanceTone = "ok" | "near" | "exceeded";

export interface ContributionAllowanceRowView {
  allowanceId: string;
  label: string;
  year: number;
  capMinor: number;
  consumedMinor: number;
  /** `cap − consumed`, signed: negative once the cap is exceeded. */
  remainingMinor: number;
  /** The amount to print after the "quedan"/"te has pasado" word — always ≥ 0. */
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
    allowanceId: allowance.id,
    barPercent: Math.max(0, Math.min(100, ratio * 100)),
    capMinor: usage.capMinor,
    consumedMinor: usage.consumedMinor,
    destinationNames,
    label: allowance.label,
    remainderAmountMinor: Math.abs(usage.remainingMinor),
    remainderWord: usage.remainingMinor < 0 ? "excedido" : "quedan",
    remainingMinor: usage.remainingMinor,
    skippedForeignCount: usage.skippedForeignCount,
    tone: usage.exceeded ? "exceeded" : ratio >= NEAR_CAP_RATIO ? "near" : "ok",
    unknownDestinationCount,
    year: usage.year,
  };
}

/**
 * The holdings a cupo may point at: those with an **operation ledger**.
 *
 * A cupo counts real entries, and only a unit-based (investment) holding records
 * them one by one. A stored-value destination would silently count 0 — the
 * counter lying downwards, which is exactly the failure this feature exists to
 * prevent — so it is not offered at all rather than offered and wrong.
 */
export function contributionAllowanceDestinationOptions(
  assets: readonly ManualAsset[],
): ManualAsset[] {
  return assets.filter((asset) => asset.type === "investment");
}
