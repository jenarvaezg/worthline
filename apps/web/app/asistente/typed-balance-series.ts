/**
 * A dated balance series the USER TYPED, read by worthline itself (#1418).
 *
 * The hole this closes, found with a real user: an `.xlsx` worthline could read but
 * not type closes the unvalidated-evidence gate (#1248) for the whole conversation,
 * and the ONLY thing that reopens it is uploading another file. So the assistant
 * asked Jorge to paste the figures by hand, he pasted 360 months of balances — and
 * nothing happened, because typing the data counted as nothing at all. That
 * contradicts the reasoning the gate itself declares for the neighbouring case: when
 * the source is the user's own text, the path is the ordinary manual one.
 *
 * Why the gate could not simply be told «trust the user's message»: the model has
 * the unreadable grid in its context, so it could «remember» rows from it and hand
 * them over as if the user had written them. That is why this module exists as a
 * PARSER and not as a flag. worthline reads the series off the user's own message
 * with no model in the loop, and the reopened lane builds from THESE rows — never
 * from the model's arguments. Same discipline as #1373, applied to a message instead
 * of a document.
 *
 * Everything ambiguous FAILS CLOSED — no series, the gate stays shut and the app
 * says so ({@link ../unvalidated-evidence-notice}). A column guessed wrong would be
 * a bulk write nobody validated, which is the one outcome the boundary exists to
 * prevent; a refusal only costs the user the deterministic route.
 *
 * What it does NOT promise: that the reading is complete. A line the parser cannot
 * see (a shape it does not know, a row split over two lines) is a point missing from
 * the curve — visible on the proposal card point by point, and measured against the
 * live witnesses before anything is written (#1422). The ceremony is the backstop
 * here exactly as it is for a document.
 */

import type { UIMessage } from "ai";

import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  isIsoDay,
  normalizeExtractedNumber,
} from "./attachment-extraction-contract";

/** ONE observed balance, in the shape the debt-series lanes already take. */
export interface TypedBalanceRow {
  /** YYYY-MM-DD, always a real day on the calendar. */
  date: string;
  /** The observed balance in integer minor units, always positive. */
  balanceMinor: number;
}

/**
 * Two points, because that is the least a curve can be drawn through. A single
 * figure is not a series and has its own open door: `propose_correction` accepts a
 * fact verifiable at a glance even while the gate bites.
 */
export const MIN_TYPED_BALANCE_SERIES_ROWS = 2;

/**
 * The document name the proposal records for a series read off the chat. Fixed by
 * the app, never taken from the model's `documentName`: what backs these rows is the
 * user's message, and letting the model name a spreadsheet here would put a file's
 * name on a write no file grounds.
 */
export const TYPED_BALANCE_SERIES_DOCUMENT_NAME = "serie-escrita-en-el-chat";

/**
 * How far into one message the parser looks. A pasted series is bounded by
 * {@link ATTACHMENT_EXTRACTION_LIMITS_V1}'s row cap; this bounds the WORK done on a
 * message that is not a series at all, before the row cap can even be applied.
 */
const MAX_SCANNED_LINES = 4000;

/** `YYYY-MM-DD`. Tried first: it can never be read as the local shape below. */
const ISO_DATE = /\d{4}-\d{2}-\d{2}/u;

/** `D/M/YYYY`, `D-M-YYYY`, `D.M.YYYY` — how a Spanish sheet prints a date. */
const LOCAL_DATE = /(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/u;

/** Currency marks that ride along with a figure and are not part of it. */
const CURRENCY_MARKS = /[€$£]|\bEUR\b|\bUSD\b/giu;

/** One line's date, and the line with that date cut out of it. */
interface DatedLine {
  date: string;
  rest: string;
}

/**
 * The date this line observes, or `null` when it carries none.
 *
 * A date-SHAPED token that is not a real day (`31/02/2025`) is not «no date»: it is
 * a line whose reading we got wrong, so it aborts the whole parse rather than
 * silently dropping one point of somebody's mortgage.
 */
function dateInLine(line: string): DatedLine | null | "invalid" {
  const iso = ISO_DATE.exec(line);
  if (iso) {
    return isIsoDay(iso[0]) ? { date: iso[0], rest: cut(line, iso) } : "invalid";
  }
  const local = LOCAL_DATE.exec(line);
  if (!local) return null;
  const [, day, month, year] = local as unknown as [string, string, string, string];
  const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isIsoDay(date) ? { date, rest: cut(line, local) } : "invalid";
}

function cut(line: string, match: RegExpExecArray): string {
  return line.slice(0, match.index) + line.slice(match.index + match[0].length);
}

/**
 * Every figure on the line, in the order it is printed.
 *
 * A token ending in `%` is dropped: an interest rate is not a balance, and leaving
 * it in gives the column heuristic below one more decreasing series to weigh. Tokens
 * are cut on whitespace, `|` and `;` — never on the comma, which is the decimal
 * separator of every figure this parser is here to read.
 */
function amountsInLine(text: string): number[] {
  return text
    .split(/[\s|;]+/u)
    .map((token) => token.replace(CURRENCY_MARKS, "").trim())
    .filter((token) => token !== "" && !token.endsWith("%"))
    .flatMap((token) => {
      const value = normalizeExtractedNumber(token);
      return value === null ? [] : [value];
    });
}

/** A line that observes something: one date and at least one figure. */
interface ObservationLine {
  date: string;
  amounts: number[];
}

/**
 * The column that BEHAVES like the balance of a debt, as magnitudes in row order.
 *
 * Three conditions, and each one throws out a real column of a real amortization
 * table: consistently signed (a bank app prints the mortgage negative, and a column
 * that changes sign is not one series), never going up (which drops «capital
 * amortizado» and the row number), and lower at the end than at the start (which
 * drops the constant «cuota» that the previous condition alone would admit). The
 * tie-break is magnitude: interest also falls month after month, and it is an order
 * of magnitude below the outstanding balance.
 *
 * `null` when nothing qualifies — the honest answer for a paste whose balance we
 * cannot point at.
 */
function balanceColumn(rows: readonly ObservationLine[]): number[] | null {
  const width = rows[0]?.amounts.length ?? 0;
  let best: number[] | null = null;
  for (let column = 0; column < width; column += 1) {
    const values = rows.map((row) => row.amounts[column]!);
    const signed = values.filter((value) => value !== 0);
    if (!(signed.every((value) => value > 0) || signed.every((value) => value < 0))) {
      continue;
    }
    const magnitudes = values.map(Math.abs);
    const first = magnitudes[0]!;
    const last = magnitudes[magnitudes.length - 1]!;
    if (magnitudes.some((value, index) => index > 0 && value > magnitudes[index - 1]!)) {
      continue;
    }
    if (!(first > last)) continue;
    if (best === null || first > best[0]!) best = magnitudes;
  }
  return best;
}

/**
 * The dated balance series written in `text`, or an empty array when there is none.
 *
 * The regularity check is the load-bearing one: every observation line must carry the
 * SAME number of figures. A table is regular, and a paste that is not lets the column
 * heuristic compare figures that are not the same quantity — so an irregular paste is
 * refused rather than read. Repeated dates are refused for the same reason: two
 * balances on one day are two different series, and nothing here may choose between
 * them.
 */
export function parseTypedBalanceSeries(text: string): TypedBalanceRow[] {
  const observations: ObservationLine[] = [];
  for (const line of text.split("\n").slice(0, MAX_SCANNED_LINES)) {
    const dated = dateInLine(line);
    if (dated === "invalid") return [];
    if (dated === null) continue;
    const amounts = amountsInLine(dated.rest);
    if (amounts.length === 0) continue;
    observations.push({ amounts, date: dated.date });
  }

  if (observations.length < MIN_TYPED_BALANCE_SERIES_ROWS) return [];
  if (observations.length > ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows) return [];
  if (new Set(observations.map((row) => row.amounts.length)).size !== 1) return [];
  if (new Set(observations.map((row) => row.date)).size !== observations.length)
    return [];

  const sorted = [...observations].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const balances = balanceColumn(sorted);
  if (balances === null) return [];

  const series = sorted.map((row, index) => ({
    balanceMinor: Math.round(balances[index]! * 100),
    date: row.date,
  }));
  return series.every((row) => Number.isSafeInteger(row.balanceMinor)) ? series : [];
}

/**
 * The series typed in THIS turn — the last user message and nothing else.
 *
 * Scoped to this turn on purpose (and to the user's own role): a series recited by
 * the ASSISTANT is the model quoting the document worthline could not validate, which
 * is precisely what the gate is protecting against. Reaching back into earlier user
 * turns would be the same leak one message removed.
 */
export function typedBalanceSeriesInTurn(
  messages: readonly UIMessage[],
): TypedBalanceRow[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    return parseTypedBalanceSeries(
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => (part as { text: string }).text)
        .join("\n"),
    );
  }
  return [];
}
