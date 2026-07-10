/**
 * Contribution plan — forward savings intentions (ADR 0041, PRD #553 S1).
 *
 * A scope's planned contributions are forecast metadata only: they never enter
 * net worth or snapshots. Occurrences are derived on read for the pending list
 * (S2) and the what-if (S4). Reconciliation / fulfillment storage lives in S2.
 */

import { multiplyToMinor } from "./decimal";
import type { FireScopeConfig } from "./fire";

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type ContributionCadence =
  | { kind: "weekly"; weekday: IsoWeekday }
  | { kind: "monthly"; dayOfMonth: number }
  | { kind: "quarterly" }
  | { kind: "annual" };

export type PlannedContributionAmount =
  | { mode: "money"; valueMinor: number }
  | { mode: "units"; value: string };

export interface PlannedContribution {
  id: string;
  destinationHoldingId: string;
  amount: PlannedContributionAmount;
  cadence: ContributionCadence;
  startDate: string;
  endDate?: string;
}

export interface ContributionPlan {
  scopeId: string;
  contributions: PlannedContribution[];
}

/** A single forecast occurrence — pending until reconciled in S2. */
export interface ContributionOccurrence {
  id: string;
  contributionId: string;
  destinationHoldingId: string;
  plannedDate: string;
  amount: PlannedContributionAmount;
}

const CADENCE_STEP_MONTHS: Record<
  Exclude<ContributionCadence["kind"], "weekly">,
  number
> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

function parse(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function toISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysInMonth(year: number, monthIdx: number): number {
  return new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
}

function addMonths(date: Date, n: number): Date {
  const day = date.getUTCDate();
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1));
  next.setUTCDate(Math.min(day, daysInMonth(next.getUTCFullYear(), next.getUTCMonth())));
  return next;
}

function isoWeekday(date: Date): IsoWeekday {
  const day = date.getUTCDay();
  return (day === 0 ? 7 : day) as IsoWeekday;
}

function advanceToWeekday(date: Date, weekday: IsoWeekday): Date {
  const current = isoWeekday(date);
  const delta = (weekday - current + 7) % 7;
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + delta);
  return next;
}

function monthlyAnchor(startDate: string, dayOfMonth: number): Date {
  const start = parse(startDate);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const clampedDay = Math.min(dayOfMonth, daysInMonth(year, month));
  let candidate = new Date(Date.UTC(year, month, clampedDay));
  if (toISO(candidate) < startDate) {
    candidate = addMonths(candidate, 1);
    const nextYear = candidate.getUTCFullYear();
    const nextMonth = candidate.getUTCMonth();
    candidate.setUTCDate(Math.min(dayOfMonth, daysInMonth(nextYear, nextMonth)));
  }
  return candidate;
}

function occurrenceAt(contribution: PlannedContribution, k: number): Date {
  const { cadence, startDate } = contribution;
  if (cadence.kind === "weekly") {
    const first = advanceToWeekday(parse(startDate), cadence.weekday);
    return new Date(first.getTime() + 7 * 86_400_000 * k);
  }
  if (cadence.kind === "monthly") {
    return addMonths(monthlyAnchor(startDate, cadence.dayOfMonth), k);
  }
  const start = parse(startDate);
  const step = CADENCE_STEP_MONTHS[cadence.kind];
  return addMonths(start, step * k);
}

export function contributionOccurrenceId(
  contributionId: string,
  plannedDate: string,
): string {
  return `${contributionId}:${plannedDate}`;
}

function isActiveOn(contribution: PlannedContribution, dateISO: string): boolean {
  if (contribution.startDate > dateISO) return false;
  if (contribution.endDate !== undefined && contribution.endDate < dateISO) return false;
  return true;
}

function occurrenceInWindow(
  contribution: PlannedContribution,
  plannedDate: string,
  fromDate: string,
  toDate: string,
): boolean {
  if (plannedDate < fromDate || plannedDate > toDate) return false;
  if (plannedDate < contribution.startDate) return false;
  if (contribution.endDate !== undefined && plannedDate > contribution.endDate)
    return false;
  return true;
}

export function expandPlannedContribution(
  contribution: PlannedContribution,
  fromDate: string,
  toDate: string,
): ContributionOccurrence[] {
  const occurrences: ContributionOccurrence[] = [];
  for (let k = 0; k < 20_000; k += 1) {
    const cursor = occurrenceAt(contribution, k);
    const plannedDate = toISO(cursor);
    if (plannedDate > toDate) break;
    if (!occurrenceInWindow(contribution, plannedDate, fromDate, toDate)) continue;
    occurrences.push({
      id: contributionOccurrenceId(contribution.id, plannedDate),
      contributionId: contribution.id,
      destinationHoldingId: contribution.destinationHoldingId,
      plannedDate,
      amount: contribution.amount,
    });
  }
  return occurrences;
}

export function expandContributionPlan(
  plan: ContributionPlan,
  fromDate: string,
  toDate: string,
): ContributionOccurrence[] {
  return plan.contributions
    .flatMap((contribution) => expandPlannedContribution(contribution, fromDate, toDate))
    .sort(
      (a, b) => a.plannedDate.localeCompare(b.plannedDate) || a.id.localeCompare(b.id),
    );
}

function cadenceMonthlyFactor(cadence: ContributionCadence): number {
  switch (cadence.kind) {
    case "weekly":
      return 52 / 12;
    case "monthly":
      return 1;
    case "quarterly":
      return 1 / 3;
    case "annual":
      return 1 / 12;
  }
}

function occurrenceMoneyMinor(
  contribution: PlannedContribution,
  unitPriceMajorByHoldingId?: Record<string, string>,
): number | null {
  if (contribution.amount.mode === "money") {
    return contribution.amount.valueMinor;
  }
  const price = unitPriceMajorByHoldingId?.[contribution.destinationHoldingId];
  if (price === undefined) return null;
  return multiplyToMinor(contribution.amount.value, price);
}

function monthlyEquivalentMinor(
  contribution: PlannedContribution,
  unitPriceMajorByHoldingId?: Record<string, string>,
): number {
  const perOccurrence = occurrenceMoneyMinor(contribution, unitPriceMajorByHoldingId);
  if (perOccurrence === null) return 0;
  return Math.round(perOccurrence * cadenceMonthlyFactor(contribution.cadence));
}

/**
 * Sum of active contributions' monthly-equivalent totals in minor units.
 * When the plan is empty, returns `fallbackMinor` (default 0).
 */
export function derivedMonthlySavingsCapacity(
  plan: ContributionPlan,
  todayISO: string,
  fallbackMinor = 0,
  unitPriceMajorByHoldingId?: Record<string, string>,
): number {
  if (plan.contributions.length === 0) {
    return fallbackMinor;
  }

  return plan.contributions.reduce((sum, contribution) => {
    if (!isActiveOn(contribution, todayISO)) return sum;
    return sum + monthlyEquivalentMinor(contribution, unitPriceMajorByHoldingId);
  }, 0);
}

/**
 * Single source of truth for `projectFire`'s flat monthly contribution input:
 * derived from the plan when it has rows, otherwise the manual scalar.
 */
export function resolveMonthlySavingsCapacityForFire(
  plan: ContributionPlan | null | undefined,
  config: FireScopeConfig,
  todayISO: string,
  unitPriceMajorByHoldingId?: Record<string, string>,
): number {
  const fallback = config.monthlySavingsCapacityMinor ?? 0;
  if (!plan || plan.contributions.length === 0) {
    return fallback;
  }
  return derivedMonthlySavingsCapacity(
    plan,
    todayISO,
    fallback,
    unitPriceMajorByHoldingId,
  );
}
