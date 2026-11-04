/**
 * The «Aportación» tab of a holding MyInvestor owns, in words (#1886, design B):
 * the schedule as one line, the note on who changes it and whether it warns, and
 * the occurrences with the order that matched each. Pure, so the copy is tested
 * and the section only lays it out.
 *
 * The calendar itself is `myInvestorArrivals`; this only says it.
 */

import {
  MYINVESTOR_ARRIVAL_WINDOW,
  type MyInvestorArrivalStatus,
  type MyInvestorSchedule,
  myInvestorHoldingArrivals,
  myInvestorMissingArrivals,
} from "@web/ajustes/myinvestor-contributions";
import { contributionCadenceWords } from "@web/objetivos/contribution-cadence-words";
import { formatDay } from "@web/objetivos/format-day";
import type { ContributionCadence, InvestmentOperation } from "@worthline/domain";
import { formatMoneyMinorExact, maskMoneyString } from "@worthline/domain";

const STATUS_WORDS: Record<MyInvestorArrivalStatus, string> = {
  arrived: "llegó",
  missing: "no ha llegado",
  scheduled: "programada",
  unchecked: "sin comprobar",
  // Due, with its window still open at the last read.
  waiting: "en plazo",
};

export interface ScheduledContributionRow {
  key: string;
  /** The scheduled day. */
  date: string;
  /** «8 sep 2026 · 87,43 €», or «—». */
  order: string;
  status: string;
  /** `missing` is said in the warning's tone; everything else in ink. */
  tone: "missing" | null;
}

export interface ScheduledContributionBlock {
  key: string;
  /**
   * «Programada en MyInvestor:» for a running one; null for a stopped one, whose
   * line opens with what stopped it («Cancelada en MyInvestor…»).
   */
  lead: string | null;
  line: string;
  /** Most recent first; empty for a stopped schedule beside a running one. */
  rows: ScheduledContributionRow[];
}

export interface ScheduledContributionView {
  blocks: ScheduledContributionBlock[];
  note: string;
  /** What the band warns about — each running schedule's latest — in money. */
  missing: { date: string; amount: string }[];
}

function cadenceWords(
  cadence: ContributionCadence | null,
  recurrence: string | null,
): string {
  if (cadence === null)
    return recurrence
      ? `con una periodicidad que worthline no sabe leer (${recurrence})`
      : "sin periodicidad conocida";
  return contributionCadenceWords(cadence);
}

function scheduleLine(
  schedule: MyInvestorSchedule,
  input: { amount: string; lastDue: string | null; today: string },
): string {
  const what = `${input.amount} ${cadenceWords(schedule.cadence, schedule.recurrence)}`;
  const from = schedule.fromAccount ? `, desde ${schedule.fromAccount}` : "";
  if (schedule.active) {
    const next = schedule.nextDate ? ` Próxima: ${formatDay(schedule.nextDate)}.` : "";
    const until = schedule.endDate ? ` Hasta ${formatDay(schedule.endDate)}.` : "";
    return `${what}${from}.${next}${until}`;
  }
  const ended =
    schedule.status === "ACTIVE" && schedule.endDate && schedule.endDate < input.today
      ? `Terminó el ${formatDay(schedule.endDate)}`
      : `Cancelada en MyInvestor${input.lastDue ? `; la última programada fue la del ${formatDay(input.lastDue)}` : ""}`;
  return `${ended}. Era de ${what}${from}.`;
}

/**
 * The tab, from the holding's schedules (running ones first) and its ledger. A
 * stopped schedule shows its calendar only when nothing else runs: beside a
 * running one, its history is noise.
 */
export function scheduledContributionView(
  schedules: readonly MyInvestorSchedule[],
  input: {
    ledger: readonly InvestmentOperation[];
    readOn: string;
    today: string;
    savedPassword: boolean;
    privacyMode: boolean;
  },
): ScheduledContributionView {
  const anyRunning = schedules.some((schedule) => schedule.active);
  const missing: ScheduledContributionView["missing"] = [];
  // One ledger for all of the holding's schedules: an order answers for one only.
  const arrivalsBySchedule = myInvestorHoldingArrivals(schedules, input);
  const blocks = schedules.map((schedule, index): ScheduledContributionBlock => {
    // To the cent: a scheduled amount is a figure the user typed in MyInvestor.
    const money = (amountMinor: number) => {
      const exact = formatMoneyMinorExact({ amountMinor, currency: schedule.currency });
      return input.privacyMode ? maskMoneyString(exact) : exact;
    };
    const arrivals = arrivalsBySchedule[index] ?? [];
    const amount = money(schedule.amountMinor);
    // The band says the latest one that did not arrive, once per running schedule;
    // the tab lists every one.
    const latestMissing = schedule.active
      ? myInvestorMissingArrivals(arrivals)[0]
      : undefined;
    if (latestMissing) missing.push({ amount, date: latestMissing.date });
    const lastDue = arrivals.find((row) => row.status !== "scheduled")?.date ?? null;
    const showRows = schedule.active || !anyRunning;
    return {
      key: schedule.id,
      lead: schedule.active ? "Programada en MyInvestor:" : null,
      line: scheduleLine(schedule, { amount, lastDue, today: input.today }),
      rows: showRows
        ? arrivals.map((row) => ({
            date: formatDay(row.date),
            key: row.date,
            order: row.order
              ? `${formatDay(row.order.date)} · ${money(row.order.amountMinor)}`
              : "—",
            status: STATUS_WORDS[row.status],
            tone: row.status === "missing" ? "missing" : null,
          }))
        : [],
    };
  });
  const lead = "Se cambia en MyInvestor; worthline la lee al ponerse al día.";
  return {
    blocks,
    missing: missing.sort((a, b) => b.date.localeCompare(a.date)),
    note: input.savedPassword
      ? `${lead} Si una no llega a los ${MYINVESTOR_ARRIVAL_WINDOW} días hábiles, te avisa.`
      : `${lead} Sin la contraseña guardada no puede avisarte de si llega.`,
  };
}

/** The band's line for one that did not arrive (#1886). */
export function scheduledContributionMissingText(missing: {
  date: string;
  amount: string;
}): string {
  return `La aportación del ${formatDay(missing.date)} no ha llegado: MyInvestor la tenía programada (${missing.amount}) y no hay ninguna orden que case.`;
}
