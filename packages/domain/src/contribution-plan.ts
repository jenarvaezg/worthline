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

/** Money amounts use integer minor units; unit amounts use a decimal string. */
export type PlannedContributionAmount =
  | { mode: "money"; value: number }
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

export type MonthlySavingsCapacitySource =
  | "plan_derived"
  | "manual_fallback"
  | "incomplete_unit_pricing";

export interface MonthlySavingsCapacityResolution {
  capacityMinor: number;
  source: MonthlySavingsCapacitySource;
  /** Active unit contributions whose holding lacks a unit price for conversion. */
  missingUnitPriceHoldingIds?: string[];
}

const CADENCE_STEP_MONTHS: Record<
  Exclude<ContributionCadence["kind"], "weekly">,
  number
> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_STRING = /^\d+(\.\d+)?$/;

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

function monthlyOccurrenceAt(startDate: string, dayOfMonth: number, k: number): Date {
  const anchor = monthlyAnchor(startDate, dayOfMonth);
  const targetMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + k;
  const year = Math.floor(targetMonth / 12);
  const month = targetMonth % 12;
  const date = new Date(Date.UTC(year, month, 1));
  date.setUTCDate(Math.min(dayOfMonth, daysInMonth(year, month)));
  return date;
}

function occurrenceAt(contribution: PlannedContribution, k: number): Date {
  const { cadence, startDate } = contribution;
  if (cadence.kind === "weekly") {
    const first = advanceToWeekday(parse(startDate), cadence.weekday);
    return new Date(first.getTime() + 7 * 86_400_000 * k);
  }
  if (cadence.kind === "monthly") {
    return monthlyOccurrenceAt(startDate, cadence.dayOfMonth, k);
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
    return contribution.amount.value;
  }
  const price = unitPriceMajorByHoldingId?.[contribution.destinationHoldingId];
  if (price === undefined) return null;
  return multiplyToMinor(contribution.amount.value, price);
}

function monthlyEquivalentMinor(
  contribution: PlannedContribution,
  unitPriceMajorByHoldingId?: Record<string, string>,
): number | null {
  const perOccurrence = occurrenceMoneyMinor(contribution, unitPriceMajorByHoldingId);
  if (perOccurrence === null) return null;
  return Math.round(perOccurrence * cadenceMonthlyFactor(contribution.cadence));
}

export function activeUnitContributionsMissingPrices(
  plan: ContributionPlan,
  todayISO: string,
  unitPriceMajorByHoldingId?: Record<string, string>,
): string[] {
  const missing = new Set<string>();
  for (const contribution of plan.contributions) {
    if (!isActiveOn(contribution, todayISO)) continue;
    if (contribution.amount.mode !== "units") continue;
    if (unitPriceMajorByHoldingId?.[contribution.destinationHoldingId] === undefined) {
      missing.add(contribution.destinationHoldingId);
    }
  }
  return [...missing].sort();
}

/**
 * Sum of active contributions' monthly-equivalent totals in minor units.
 * When the plan is empty, returns `fallbackMinor` (default 0).
 * Returns null when an active units contribution lacks a unit price.
 */
export function derivedMonthlySavingsCapacity(
  plan: ContributionPlan,
  todayISO: string,
  fallbackMinor = 0,
  unitPriceMajorByHoldingId?: Record<string, string>,
): number | null {
  if (plan.contributions.length === 0) {
    return fallbackMinor;
  }

  let sum = 0;
  for (const contribution of plan.contributions) {
    if (!isActiveOn(contribution, todayISO)) continue;
    const monthly = monthlyEquivalentMinor(contribution, unitPriceMajorByHoldingId);
    if (monthly === null) return null;
    sum += monthly;
  }
  return sum;
}

/**
 * Single source of truth for `projectFire`'s flat monthly contribution input:
 * derived from the plan when it has rows, otherwise the manual scalar.
 * When unit amounts cannot be converted, falls back to the manual scalar and
 * reports the missing holding ids explicitly.
 */
export function resolveMonthlySavingsCapacityForFire(
  plan: ContributionPlan | null | undefined,
  config: FireScopeConfig,
  todayISO: string,
  unitPriceMajorByHoldingId?: Record<string, string>,
): MonthlySavingsCapacityResolution {
  const fallback = config.monthlySavingsCapacityMinor ?? 0;
  if (!plan || plan.contributions.length === 0) {
    return { capacityMinor: fallback, source: "manual_fallback" };
  }

  const missingUnitPriceHoldingIds = activeUnitContributionsMissingPrices(
    plan,
    todayISO,
    unitPriceMajorByHoldingId,
  );
  if (missingUnitPriceHoldingIds.length > 0) {
    return {
      capacityMinor: fallback,
      source: "incomplete_unit_pricing",
      missingUnitPriceHoldingIds,
    };
  }

  return {
    capacityMinor:
      derivedMonthlySavingsCapacity(
        plan,
        todayISO,
        fallback,
        unitPriceMajorByHoldingId,
      ) ?? fallback,
    source: "plan_derived",
  };
}

function assertIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) {
    throw new Error(`${label} must be in YYYY-MM-DD format, got "${value}".`);
  }
}

function assertPositiveMoneyMinor(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer minor-unit amount.`);
  }
}

function assertUnitsValue(value: string, label: string): void {
  if (!DECIMAL_STRING.test(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive decimal string.`);
  }
}

/** Normalize persisted JSON that may still use the pre-S1 `valueMinor` field. */
export function parsePlannedContributionAmount(raw: unknown): PlannedContributionAmount {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Planned contribution amount must be an object.");
  }
  const record = raw as Record<string, unknown>;
  if (record.mode === "money") {
    const value =
      typeof record.value === "number"
        ? record.value
        : typeof record.valueMinor === "number"
          ? record.valueMinor
          : null;
    if (value === null) {
      throw new Error('Money amount must include integer minor units in "value".');
    }
    assertPositiveMoneyMinor(value, "Money amount");
    return { mode: "money", value };
  }
  if (record.mode === "units") {
    if (typeof record.value !== "string") {
      throw new Error('Units amount must include a decimal string in "value".');
    }
    assertUnitsValue(record.value, "Units amount");
    return { mode: "units", value: record.value };
  }
  throw new Error('Amount mode must be "money" or "units".');
}

export function assertContributionCadence(cadence: ContributionCadence): void {
  switch (cadence.kind) {
    case "weekly":
      if (
        !Number.isInteger(cadence.weekday) ||
        cadence.weekday < 1 ||
        cadence.weekday > 7
      ) {
        throw new Error("Weekly cadence weekday must be an ISO weekday between 1 and 7.");
      }
      return;
    case "monthly":
      if (
        !Number.isInteger(cadence.dayOfMonth) ||
        cadence.dayOfMonth < 1 ||
        cadence.dayOfMonth > 31
      ) {
        throw new Error("Monthly cadence dayOfMonth must be between 1 and 31.");
      }
      return;
    case "quarterly":
    case "annual":
      return;
  }
}

export function assertPlannedContributionInput(input: {
  destinationHoldingId: string;
  amount: PlannedContributionAmount;
  cadence: ContributionCadence;
  startDate: string;
  endDate?: string | null;
}): void {
  if (!input.destinationHoldingId.trim()) {
    throw new Error("destinationHoldingId is required.");
  }
  if (input.amount.mode === "money") {
    assertPositiveMoneyMinor(input.amount.value, "Money amount");
  } else {
    assertUnitsValue(input.amount.value, "Units amount");
  }
  assertContributionCadence(input.cadence);
  assertIsoDate(input.startDate, "Start date");
  if (input.endDate != null) {
    assertIsoDate(input.endDate, "End date");
    if (input.endDate < input.startDate) {
      throw new Error(
        `End date must be on or after start date, got end "${input.endDate}" < start "${input.startDate}".`,
      );
    }
  }
}
