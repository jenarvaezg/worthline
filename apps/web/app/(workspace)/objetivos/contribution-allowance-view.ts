import type {
  ContributionAllowance,
  ContributionAllowanceEntry,
  ContributionAllowanceUsage,
  InvestmentOperation,
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
  /**
   * Marked destinations whose holding does not exist at all — their entries are
   * genuinely unseen. A destination merely in the trash does NOT count here: its
   * entries are counted (#1509), so it is named instead of tallied as invisible.
   */
  unknownDestinationCount: number;
  /** In-year entries not counted because they are denominated elsewhere (#1401). */
  skippedForeignCount: number;
  /** The counted entries, most recent first — the audit trail of the figure. */
  entries: ContributionAllowanceEntry[];
}

export function contributionAllowanceRowView(input: {
  allowance: ContributionAllowance;
  usage: ContributionAllowanceUsage;
  /** Names of every holding a destination may resolve to, INCLUDING trashed ones (#1509). */
  holdingNameById: ReadonlyMap<string, string>;
  /** Which of those names belong to a holding in the trash, so the label can say so. */
  trashedHoldingIds?: ReadonlySet<string>;
}): ContributionAllowanceRowView {
  const { allowance, holdingNameById, trashedHoldingIds, usage } = input;
  const ratio = usage.consumedRatio ?? 0;

  const destinationNames: string[] = [];
  let unknownDestinationCount = 0;
  for (const holdingId of allowance.holdingIds) {
    const name = holdingNameById.get(holdingId);
    if (name === undefined) {
      unknownDestinationCount += 1;
      continue;
    }
    // A trashed destination is named and marked, not hidden: its contributions
    // are counted, so calling it "not on this screen" would be the lie (#1509).
    destinationNames.push(
      trashedHoldingIds?.has(holdingId) ? `${name} (en la papelera)` : name,
    );
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
 * The operations a cupo counts (#1509).
 *
 * A cupo counts **facts of the calendar year**, not live holdings: money paid
 * into a pension plan in May consumed that year's room, and sending the holding
 * to the trash in August does not hand it back. But the page's operation list is
 * built by walking the holdings it paints, so a trashed destination silently
 * dropped its contributions out of the sum — Jorge's counter read 1.104 € and
 * offered 396 € when 1.300 € was already in and only 200 € was left.
 *
 * So the destinations a cupo marks decide what to read, not the holdings that
 * happen to be alive. Deliberately additive over `liveOperations`: it only pulls
 * in ids the live list cannot have contributed, so nothing is counted twice, and
 * an id no cupo marks stays out even when its operations are in the map.
 *
 * The domain (`computeContributionAllowanceUsage`) still owns which of these
 * count — buys only, in-year, in the cap's currency.
 */
export function contributionAllowanceOperations(input: {
  allowances: readonly ContributionAllowance[];
  /** The operations already gathered from the live holdings on the page. */
  liveOperations: readonly InvestmentOperation[];
  /** Every asset's ledger, trashed holdings included (`readAllOperations`). */
  operationsByAsset: ReadonlyMap<string, readonly InvestmentOperation[]>;
  liveHoldingIds: ReadonlySet<string>;
}): InvestmentOperation[] {
  const { allowances, liveHoldingIds, liveOperations, operationsByAsset } = input;

  const missing = new Set<string>();
  for (const allowance of allowances) {
    for (const holdingId of allowance.holdingIds) {
      if (!liveHoldingIds.has(holdingId)) missing.add(holdingId);
    }
  }
  if (missing.size === 0) return [...liveOperations];

  return [
    ...liveOperations,
    ...[...missing].flatMap((holdingId) => operationsByAsset.get(holdingId) ?? []),
  ];
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
