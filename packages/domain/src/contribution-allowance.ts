import { buyCashOutMinor } from "./investment-operation-money";
import type { InvestmentOperation } from "./investment-types";
import type { CurrencyCode } from "./money";
import { isDeclaredOpening } from "./operation-flow";

/**
 * Cupo anual de aportación (#1427) — a ceiling on what may enter a set of
 * holdings in one calendar year, and how much of it the ledger has already spent.
 *
 * The ceiling is **the user's datum, never a rule in this code**. The Spanish
 * pension-plan limit depends on the year's legislation, on employer
 * contributions and on the contributor's earned income; encoding it would be tax
 * advice, would expire on its own, and would be one jurisdiction's number in a
 * multi-currency app. A neutral editable field answers the question without any
 * of the three debts.
 *
 * The consumed side is the opposite: it is **derived from real operations** and
 * never typed, never read off the contribution plan. A counter that adds up what
 * you *meant* to contribute is worse than no counter at all, because it invites
 * you to overshoot believing there is room left.
 */
export interface ContributionAllowance {
  id: string;
  scopeId: string;
  /** What the user calls it — "Planes de pensiones". Never a jurisdiction's name. */
  label: string;
  /** The ceiling for one calendar year, in minor units. User data. */
  annualCapMinor: number;
  /**
   * The holdings whose real entries consume this allowance. Persisted as a
   * last-saved snapshot; usage always re-derives from instrument `pension_plan`
   * (#1567). A set, not one holding: a tax cap is the contributor's and aggregates
   * every plan he holds, so the second plan needs no migration.
   */
  holdingIds: string[];
}

/** One real entry that consumed part of the allowance — the audit trail of the figure. */
export interface ContributionAllowanceEntry {
  operationId: string;
  holdingId: string;
  dateISO: string;
  amountMinor: number;
}

export interface ContributionAllowanceUsage {
  allowanceId: string;
  /** The calendar year measured — the one `todayISO` falls in. */
  year: number;
  capMinor: number;
  consumedMinor: number;
  /** `cap − consumed`. **Negative when the cap has been exceeded.** */
  remainingMinor: number;
  /** `consumed / cap`, uncapped so an overshoot is visible; null when the cap is 0. */
  consumedRatio: number | null;
  exceeded: boolean;
  /** The counted entries, most recent first. */
  entries: ContributionAllowanceEntry[];
  /** In-year entries left out because they are denominated elsewhere (#1401). */
  skippedForeignCount: number;
}

export interface ComputeContributionAllowanceUsageInput {
  allowance: ContributionAllowance;
  operations: readonly InvestmentOperation[];
  /** The day the counter is read; its calendar year is the window. */
  todayISO: string;
  /**
   * The currency the cap is declared in. Only operations denominated in it are
   * counted; the rest are reported in `skippedForeignCount` and never summed —
   * adding dollars to euros is the very bug #1401 fixed. Required, deliberately:
   * an "omit to sum everything as given" mode would be that bug behind a default.
   */
  currency: CurrencyCode;
}

/**
 * How much of an allowance the calendar year has already spent.
 *
 * Only **buys** count. A sell is a withdrawal, and pulling money back out of a
 * pension plan does not hand back the room to put it in again — netting the two
 * would print contribution capacity that does not exist.
 */
export function computeContributionAllowanceUsage(
  input: ComputeContributionAllowanceUsageInput,
): ContributionAllowanceUsage {
  const { allowance, currency, operations, todayISO } = input;
  const yearPrefix = todayISO.slice(0, 4);
  const destinations = new Set(allowance.holdingIds);

  const entries: ContributionAllowanceEntry[] = [];
  let consumedMinor = 0;
  let skippedForeignCount = 0;

  for (const operation of operations) {
    if (!destinations.has(operation.assetId)) continue;
    // Buys only, so a sale never gives allowance back — and neither does the
    // incoming half of a traspaso (#1393): moving a pension plan to another
    // manager is not a contribution, and counting it would eat a whole year's
    // ceiling on the day the capital merely changed hands.
    if (operation.kind !== "buy") continue;
    // An apertura is a buy that declares pre-existing wealth, not a contribution
    // (#1567, #1504): counting it would eat the year's ceiling on the day the
    // position merely entered the book.
    if (isDeclaredOpening(operation)) continue;
    if (operation.executedAt.slice(0, 4) !== yearPrefix) continue;
    if (operation.currency !== currency) {
      skippedForeignCount += 1;
      continue;
    }

    const amountMinor = buyCashOutMinor(operation);
    consumedMinor += amountMinor;
    entries.push({
      amountMinor,
      dateISO: operation.executedAt,
      holdingId: operation.assetId,
      operationId: operation.id,
    });
  }

  entries.sort(
    (a, b) =>
      b.dateISO.localeCompare(a.dateISO) || a.operationId.localeCompare(b.operationId),
  );

  return {
    allowanceId: allowance.id,
    capMinor: allowance.annualCapMinor,
    consumedMinor,
    consumedRatio:
      allowance.annualCapMinor > 0 ? consumedMinor / allowance.annualCapMinor : null,
    entries,
    exceeded: consumedMinor > allowance.annualCapMinor,
    remainingMinor: allowance.annualCapMinor - consumedMinor,
    skippedForeignCount,
    year: Number(yearPrefix),
  };
}

/**
 * One contribution still to come, as somebody scheduled it (#1886): a line of the
 * worthline plan (ADR 0041), or a scheduled contribution a connected source reads
 * (MyInvestor, ADR 0115 decision 5). Already in money: a units line the caller
 * could not price is left out, never guessed.
 */
export interface ScheduledAllowanceEntry {
  holdingId: string;
  dateISO: string;
  amountMinor: number;
  origin: "plan" | "source";
  /**
   * Already due, and its order still on its way (inside its arrival window): the
   * ledger does not count it yet, so the forecast must, or it would fall between
   * the two figures.
   */
  pendingArrival?: boolean;
}

/** Where the year ends if what is scheduled arrives. */
export interface ContributionAllowanceForecast {
  /** What is still scheduled after today and within the year, to the cupo's plans. */
  scheduledMinor: number;
  /** Of that, what a connected source schedules. */
  sourceMinor: number;
  /** `consumed + scheduled`. */
  projectedMinor: number;
  /** `cap − projected`, signed: negative when the schedule would pass the ceiling. */
  projectedRemainingMinor: number;
}

/**
 * The forecast of the rest of the year (#1886): what the ledger already spent
 * plus what is scheduled from tomorrow to 31 December, to this cupo's plans.
 *
 * A forecast, beside the consumed figure and never inside it (ADR 0080, decision
 * 3): consumed stays the ledger's. An occurrence due today or earlier is left out
 * — the ledger counts it once it arrives — unless it is `pendingArrival`: due, its
 * order still on its way, in neither figure yet. Which schedule speaks for a holding — the
 * source's, never a worthline plan of a linked holding — is the caller's to
 * decide: this only adds up what it is handed. Null when nothing more is
 * scheduled this year: there is no forecast to print.
 */
export function forecastContributionAllowance(input: {
  allowance: ContributionAllowance;
  usage: ContributionAllowanceUsage;
  scheduled: readonly ScheduledAllowanceEntry[];
  todayISO: string;
}): ContributionAllowanceForecast | null {
  const { allowance, scheduled, todayISO, usage } = input;
  const destinations = new Set(allowance.holdingIds);
  const yearEnd = `${todayISO.slice(0, 4)}-12-31`;
  let scheduledMinor = 0;
  let sourceMinor = 0;
  for (const entry of scheduled) {
    if (!destinations.has(entry.holdingId)) continue;
    if (entry.dateISO > yearEnd) continue;
    if (entry.dateISO <= todayISO && entry.pendingArrival !== true) continue;
    scheduledMinor += entry.amountMinor;
    if (entry.origin === "source") sourceMinor += entry.amountMinor;
  }
  if (scheduledMinor === 0) return null;
  const projectedMinor = usage.consumedMinor + scheduledMinor;
  return {
    projectedMinor,
    projectedRemainingMinor: usage.capMinor - projectedMinor,
    scheduledMinor,
    sourceMinor,
  };
}

export function assertContributionAllowanceInput(input: {
  label: string;
  annualCapMinor: number;
  holdingIds: string[];
}): void {
  if (!input.label.trim()) {
    throw new Error("El cupo necesita un nombre.");
  }
  if (!Number.isInteger(input.annualCapMinor) || input.annualCapMinor <= 0) {
    throw new Error("El tope anual debe ser un importe mayor que cero.");
  }
  if (input.holdingIds.length === 0) {
    // A cupo with no destination counts nothing, and would print "0 € de 1.500 €"
    // — the counter lying downwards, which is the failure this feature exists to
    // avoid.
    throw new Error("El cupo necesita al menos un plan de pensiones.");
  }
}
