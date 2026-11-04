/**
 * MyInvestor's scheduled contributions, as worthline reads them (#1886, PRD #1876
 * S11; ADR 0114 decision 9, ADR 0115 decision 5). Pure: the stored discovery and
 * the holding's ledger in, the calendar out.
 *
 * Read-only by construction. A scheduled contribution is changed in MyInvestor and
 * worthline reads it on each pass (`contributions` of the stored discovery, #1884);
 * it never becomes a worthline plan line. It feeds three things and nothing else:
 *
 * - the «Aportación» tab of the linked holding: each occurrence and the order that
 *   matches it ({@link myInvestorArrivals});
 * - the band's «la aportación del día X no ha llegado» ({@link myInvestorMissingArrivals});
 * - the forecast of the pension ceiling and the monthly split on /objetivos
 *   ({@link myInvestorScheduledEntries}).
 *
 * To expand a schedule it is spelled as a {@link PlannedContribution}, so its
 * occurrences come out of the SAME engine as a worthline plan's
 * (`expandPlannedContribution`): two calendars of one cadence would drift apart.
 */

import type {
  ContributionCadence,
  InvestmentOperation,
  IsoWeekday,
  PlannedContribution,
  ScheduledAllowanceEntry,
} from "@worthline/domain";
import {
  addMonths,
  addMonthsToDate,
  expandPlannedContribution,
  isDeclaredOpening,
  multiplyToMinor,
  operationAmountMinor,
} from "@worthline/domain";
import type { MyInvestorContribution } from "@worthline/pricing";
import { myInvestorAccountId, myInvestorHoldingKey } from "@worthline/pricing";
import type { MyInvestorDiscovery } from "./myinvestor-discovery";

/**
 * How long an order may take to show up after its scheduled day: 5 business days.
 * In the captures orders land up to 3 days late (#1886), so 5 leaves room without
 * letting a month go by.
 */
export const MYINVESTOR_ARRIVAL_WINDOW = 5;

/** How many past occurrences the tab lists by default. */
const DEFAULT_LIMIT = 12;

/** A scheduled contribution of one linked holding, as worthline reads it. */
export interface MyInvestorSchedule {
  readonly id: string;
  readonly assetId: string;
  /** Running in MyInvestor today: `ACTIVE` and not past its end. */
  readonly active: boolean;
  /** MyInvestor's own status, for the words of a stopped one. */
  readonly status: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  /** The cash account it is charged to, by the name the user gave it. */
  readonly fromAccount: string | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly nextDate: string | null;
  /** MyInvestor's own word for how often (`ONE_MONTH`…). */
  readonly recurrence: string | null;
  /**
   * How often, as worthline reads it; null when it cannot. Known even when there
   * is no calendar ({@link line}): a cancelled one is still said by its cadence.
   */
  readonly cadence: ContributionCadence | null;
  /**
   * The schedule as a plan line, to expand with the plan's own engine. Null when
   * worthline cannot read its recurrence, or a stopped one says nothing of when it
   * stopped: then there is no calendar to print, only the line above it.
   */
  readonly line: PlannedContribution | null;
}

/** A linked product and its holding (`connected_source_links`). */
interface Link {
  readonly productKey: string;
  readonly assetId: string;
}

/**
 * The product a contribution buys, by the key the discovery gives it
 * (`myInvestorHoldingKey`): a plan's pension account and DGS code, a fund's
 * securities account and ISIN. Null for anything else (a robo-advisor portfolio's
 * is S8's): it belongs to no holding of its own.
 */
export function myInvestorContributionProductKey(
  contribution: MyInvestorContribution,
): string | null {
  const { productCode, toAccountId, toAccountType } = contribution;
  if (!productCode || !toAccountId) return null;
  if (toAccountType === "PENSION_PLAN") {
    return myInvestorHoldingKey(myInvestorAccountId("pension", toAccountId), {
      code: productCode,
      scheme: "dgs",
    });
  }
  if (toAccountType === "SECURITIES_ACCOUNT") {
    return myInvestorHoldingKey(myInvestorAccountId("securities", toAccountId), {
      code: productCode,
      scheme: "isin",
    });
  }
  return null;
}

const RECURRENCE = /^(ONE|THREE|TWELVE)_(WEEK|MONTH|YEAR)S?$/;

function dayOfWeek(dateKey: string): IsoWeekday {
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return (day === 0 ? 7 : day) as IsoWeekday;
}

/**
 * The cadence MyInvestor's recurrence names, anchored on `anchor` (the next
 * execution, else the start): `ONE_WEEK`, `ONE_MONTH`, `THREE_MONTHS`, `ONE_YEAR`
 * or `TWELVE_MONTHS`. The captures only show `ONE_MONTH`; any other spelling is
 * not guessed.
 */
function cadenceOf(
  recurrence: string | null,
  anchor: string,
): ContributionCadence | null {
  const match = recurrence ? RECURRENCE.exec(recurrence) : null;
  if (!match) return null;
  const [, count, unit] = match;
  if (unit === "WEEK")
    return count === "ONE" ? { kind: "weekly", weekday: dayOfWeek(anchor) } : null;
  if (unit === "YEAR") return count === "ONE" ? { kind: "annual" } : null;
  if (count === "ONE")
    return { dayOfMonth: Number(anchor.slice(8, 10)), kind: "monthly" };
  if (count === "THREE") return { kind: "quarterly" };
  return { kind: "annual" };
}

const STEP_MONTHS = { annual: 12, quarterly: 3 } as const;

/**
 * Where the expansion starts. A monthly or weekly cadence carries its own day, so
 * it starts at MyInvestor's start. A quarterly or yearly one steps from its start
 * date, so it starts at the earliest date in step with the next execution.
 */
function lineStart(cadence: ContributionCadence, start: string, anchor: string): string {
  if (cadence.kind !== "quarterly" && cadence.kind !== "annual") return start;
  const step = STEP_MONTHS[cadence.kind];
  // Each step back is measured from the anchor, never from the previous step: a
  // day clamped in a short month (30 → 28 Feb) must not stay clamped.
  let cursor = anchor;
  for (let k = 1; k < 2_000; k += 1) {
    // `addMonthsToDate`, not `addMonths`: the date-key one only walks forwards.
    const previous = addMonthsToDate(new Date(`${anchor}T00:00:00Z`), -step * k)
      .toISOString()
      .slice(0, 10);
    if (previous < start) break;
    cursor = previous;
  }
  return cursor;
}

function dayBefore(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function scheduleLine(
  contribution: MyInvestorContribution,
  assetId: string,
  amountMinor: number,
  running: boolean,
): PlannedContribution | null {
  const frame = contribution.timeFrame;
  const start = frame?.startDate ?? null;
  if (!frame || !start || amountMinor <= 0) return null;
  const next = frame.nextExecutionDate;
  const cadence = cadenceOf(frame.recurrence, next ?? start);
  if (!cadence) return null;
  // A stopped schedule ends the day before the execution it never made; one with
  // no next execution says nothing of when it stopped, so it has no calendar.
  const end = running ? frame.endDate : next ? dayBefore(next) : null;
  if (!running && end === null) return null;
  return {
    amount: { mode: "money", value: amountMinor },
    cadence,
    destinationHoldingId: assetId,
    id: contribution.contributionId,
    startDate: lineStart(cadence, start, next ?? start),
    ...(end ? { endDate: end } : {}),
  };
}

/**
 * Each linked holding's scheduled contributions, from the stored discovery. A
 * document kept before the periodic sync read them has none. `today` decides
 * whether an `ACTIVE` one is past its end.
 */
export function myInvestorSchedulesByAsset(
  discovery: MyInvestorDiscovery,
  links: readonly Link[],
  today?: string,
): Map<string, MyInvestorSchedule[]> {
  const assetByKey = new Map(links.map((link) => [link.productKey, link.assetId]));
  const cashName = new Map(
    discovery.products
      .filter((product) => product.kind === "cash")
      .map((product) => [product.key, product.name]),
  );
  const byAsset = new Map<string, MyInvestorSchedule[]>();
  for (const contribution of discovery.contributions ?? []) {
    const key = myInvestorContributionProductKey(contribution);
    const assetId = key ? assetByKey.get(key) : undefined;
    if (!assetId) continue;
    const frame = contribution.timeFrame;
    const amountMinor = multiplyToMinor(contribution.amount, "1");
    const ended = today !== undefined && frame?.endDate != null && frame.endDate < today;
    const running = contribution.status === "ACTIVE" && !ended;
    const schedule: MyInvestorSchedule = {
      active: running,
      amountMinor,
      assetId,
      currency: contribution.currency,
      endDate: frame?.endDate ?? null,
      fromAccount: contribution.fromAccountId
        ? (cashName.get(myInvestorAccountId("cash", contribution.fromAccountId)) ?? null)
        : null,
      id: contribution.contributionId,
      cadence: frame?.startDate
        ? cadenceOf(frame.recurrence, frame.nextExecutionDate ?? frame.startDate)
        : null,
      line: scheduleLine(contribution, assetId, amountMinor, running),
      nextDate: frame?.nextExecutionDate ?? null,
      recurrence: frame?.recurrence ?? null,
      startDate: frame?.startDate ?? null,
      status: contribution.status,
    };
    byAsset.set(assetId, [...(byAsset.get(assetId) ?? []), schedule]);
  }
  // The running ones first: the tab opens on what is still going on.
  for (const [assetId, list] of byAsset) {
    byAsset.set(
      assetId,
      [...list].sort(
        (a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id),
      ),
    );
  }
  return byAsset;
}

/** `dateKey` plus `count` business days (Monday to Friday; no holiday calendar). */
export function addBusinessDays(dateKey: string, count: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  let left = count;
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * - `arrived`: an order matched it;
 * - `waiting`: no order yet, and its window was still open at the last read;
 * - `missing`: its window closed before the last read with no order;
 * - `unchecked`: the same, without the saved password — nobody reads daily, so
 *   worthline does not claim it did not arrive;
 * - `scheduled`: the next one, still to come.
 */
export type MyInvestorArrivalStatus =
  | "arrived"
  | "waiting"
  | "missing"
  | "unchecked"
  | "scheduled";

export interface MyInvestorArrival {
  readonly date: string;
  readonly status: MyInvestorArrivalStatus;
  /** The order that matched it: its day and what it took out of pocket. */
  readonly order: { readonly date: string; readonly amountMinor: number } | null;
}

/**
 * Whether a ledger row can be what a scheduled contribution became: a buy that is
 * neither an apertura nor half a traspaso. Its amount is not compared: MyInvestor
 * only reports the schedule as it stands today, and a schedule whose amount was
 * changed would leave every older month «missing».
 */
function isContribution(operation: InvestmentOperation): boolean {
  return (
    operation.kind === "buy" &&
    operation.transferId === undefined &&
    !isDeclaredOpening(operation)
  );
}

/**
 * The schedule's occurrences against the holding's ledger, most recent first: the
 * next one to come (when it runs) and the last `limit` that already fell due.
 *
 * Each occurrence takes the earliest unused contribution of the ledger between its
 * day and {@link MYINVESTOR_ARRIVAL_WINDOW} business days later; an order is used
 * once. Whether a window has closed is measured against `readOn`, the day of the
 * last read: an order the last read could not see yet is not «missing».
 */
export function myInvestorArrivals(
  schedule: MyInvestorSchedule,
  input: {
    ledger: readonly InvestmentOperation[];
    readOn: string;
    today: string;
    savedPassword: boolean;
    limit?: number;
    /**
     * The ledger rows another schedule of the same holding already matched: shared
     * across a holding's schedules so one order never answers for two.
     */
    used?: Set<string>;
  },
): MyInvestorArrival[] {
  const { line } = schedule;
  if (!line) return [];
  const { readOn, savedPassword, today } = input;
  const horizon = schedule.active ? addMonths(today, 13) : (line.endDate ?? today);
  const occurrences = expandPlannedContribution(line, line.startDate, horizon).map(
    (occurrence) => occurrence.plannedDate,
  );
  const due = occurrences.filter((date) => date <= today);
  const next = schedule.active ? occurrences.find((date) => date > today) : undefined;

  const buys = input.ledger
    .filter(isContribution)
    .sort((a, b) => a.executedAt.localeCompare(b.executedAt) || a.id.localeCompare(b.id));
  const used = input.used ?? new Set<string>();
  const rows = due.map((date): MyInvestorArrival => {
    const windowEnd = addBusinessDays(date, MYINVESTOR_ARRIVAL_WINDOW);
    const inWindow = buys.filter(
      (buy) => !used.has(buy.id) && buy.executedAt >= date && buy.executedAt <= windowEnd,
    );
    // The order of its own amount first, when there is one: with two schedules on
    // one holding, each takes its own. Otherwise the earliest (the amount may have
    // been changed since).
    const order =
      inWindow.find((buy) => operationAmountMinor(buy) === schedule.amountMinor) ??
      inWindow[0];
    if (order) {
      used.add(order.id);
      return {
        date,
        order: { amountMinor: operationAmountMinor(order), date: order.executedAt },
        status: "arrived",
      };
    }
    // Closed before the last read: it is known not to have arrived — said only
    // with the password saved, the read of every day. Closed only by today: the
    // last read is too old to say either way.
    const status: MyInvestorArrivalStatus =
      windowEnd < readOn
        ? savedPassword
          ? "missing"
          : "unchecked"
        : windowEnd < today
          ? "unchecked"
          : "waiting";
    return { date, order: null, status };
  });

  const recent = rows.slice(-(input.limit ?? DEFAULT_LIMIT)).reverse();
  return next ? [{ date: next, order: null, status: "scheduled" }, ...recent] : recent;
}

/**
 * {@link myInvestorArrivals} for every schedule of one holding, running ones first,
 * against the same ledger: an order matched by one schedule is not offered to the
 * next, so two schedules never both «arrive» on one order.
 */
export function myInvestorHoldingArrivals(
  schedules: readonly MyInvestorSchedule[],
  input: {
    ledger: readonly InvestmentOperation[];
    readOn: string;
    today: string;
    savedPassword: boolean;
    limit?: number;
  },
): MyInvestorArrival[][] {
  const used = new Set<string>();
  return schedules.map((schedule) => myInvestorArrivals(schedule, { ...input, used }));
}

/**
 * The occurrences already due whose order is still on its way (`waiting`), as the
 * source's entries flagged `pendingArrival`: the ceiling forecast adds them, since
 * the ledger does not count them yet (#1886).
 */
export function myInvestorWaitingEntries(
  schedules: readonly MyInvestorSchedule[],
  input: { ledger: readonly InvestmentOperation[]; readOn: string; today: string },
): ScheduledAllowanceEntry[] {
  const running = schedules.filter((schedule) => schedule.active);
  const arrivals = myInvestorHoldingArrivals(running, { ...input, savedPassword: true });
  return running.flatMap((schedule, index) =>
    (arrivals[index] ?? [])
      .filter((row) => row.status === "waiting")
      .map(
        (row): ScheduledAllowanceEntry => ({
          amountMinor: schedule.amountMinor,
          dateISO: row.date,
          holdingId: schedule.assetId,
          origin: "source",
          pendingArrival: true,
        }),
      ),
  );
}

/**
 * What the band warns about: the occurrences that went missing after the last one
 * that arrived, most recent first. One that went missing before a later one
 * arrived is history, said in the tab and not in the band — and a schedule edited
 * in MyInvestor (another day, another amount) cannot keep a stale warning alive.
 */
export function myInvestorMissingArrivals(
  rows: readonly MyInvestorArrival[],
): MyInvestorArrival[] {
  const lastArrived = rows.find((row) => row.status === "arrived")?.date ?? "";
  return rows.filter((row) => row.status === "missing" && row.date > lastArrived);
}

/**
 * The occurrences of the running schedules between `from` and `to`, both included,
 * as the source's scheduled entries: what the ceiling forecast and the monthly
 * split add up (ADR 0080, ADR 0115 decision 5).
 */
export function myInvestorScheduledEntries(
  schedules: readonly MyInvestorSchedule[],
  range: { from: string; to: string },
): ScheduledAllowanceEntry[] {
  return schedules.flatMap((schedule) =>
    schedule.active && schedule.line
      ? expandPlannedContribution(schedule.line, range.from, range.to).map(
          (occurrence): ScheduledAllowanceEntry => ({
            amountMinor: schedule.amountMinor,
            dateISO: occurrence.plannedDate,
            holdingId: schedule.assetId,
            origin: "source",
          }),
        )
      : [],
  );
}
