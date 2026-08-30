/**
 * What the three readers of a user's own message share (#1418, #1482, #1466).
 *
 * `typed-balance-series.ts`, `typed-transfer.ts` and `typed-holding-event.ts` each read a
 * different fact — a series of balances, a traspaso, a dated operation — but they read it
 * out of the same thing, a message a person typed in es-ES, and they had grown three
 * byte-identical copies of how a date is found in one. Three is where that stops being a
 * coincidence: the fence around each pattern, the day-first decision and the
 * date-shaped-but-not-a-day case are one piece of knowledge about Spanish prose, and a
 * fourth reader must not get to have its own opinion of it.
 *
 * What is deliberately NOT here: what each reader does with the answer. The series aborts
 * the whole parse on an unreadable day, the two turn-scoped readers fail closed and name
 * the gap — same reading, different consequence, and the consequence belongs to the lane.
 *
 * Pure and I/O-free.
 */

import { isIsoDay } from "./attachment-extraction-contract";

/** How far into one message a reader looks, so a pasted book is bounded work. */
export const MAX_SCANNED_CHARS = 20_000;

/**
 * `YYYY-MM-DD`. Tried first: it can never be read as the local shape below.
 *
 * Both patterns are fenced by digit lookarounds, and that is not decoration. Without
 * them `600.12.3456` — a phone number in the prose around a paste — matches the local
 * shape starting at its second digit, yields no real day, and takes the reading down
 * with it. The fence costs nothing and removes a whole family of that.
 */
const ISO_DATE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/u;

/**
 * `D/M/YYYY`, `D-M-YYYY`, `D.M.YYYY` — how a Spanish sheet prints a date.
 *
 * DAY FIRST, always, with no attempt to detect the American order. That is a decision
 * and not an oversight: worthline is es-ES throughout, and its number reader already
 * settles the same class of ambiguity the same way («Spanish grouping wins for
 * ambiguous string values», `normalizeExtractedNumber`). A month-first paste whose day
 * exceeds twelve yields no real day and is reported as such, which is the honest
 * outcome: the person is told, rather than silently getting March read as the 3rd.
 */
const LOCAL_DATE = /(?<!\d)(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})(?!\d)/u;

/** Today, and the day before it — the only two relative days a message may name. */
const TODAY_WORDS = /\b(hoy|ahora|ahora mismo|esta mañana|esta tarde)\b/iu;
const YESTERDAY_WORDS = /\bayer\b/iu;

/** A date-shaped token found in a text, and the text with that token cut out. */
export interface DateToken {
  /**
   * The day it names, or `null` when the token is date-SHAPED but not a real day
   * (`30/02/2026`, #1395). That is never «no date»: it is a reading we got wrong, and
   * every caller has to say so rather than carry on as if nothing was written.
   */
  day: string | null;
  rest: string;
}

/**
 * The explicit date this text carries, or `null` when it carries none.
 *
 * The token is CUT OUT of what it returns, and that is the reason this returns the rest
 * at all: `12/08/2026` is three numbers to a figure scanner, so a dated message would
 * otherwise read as a message full of competing figures.
 */
export function dateTokenIn(text: string): DateToken | null {
  const iso = ISO_DATE.exec(text);
  if (iso) return { day: isIsoDay(iso[0]) ? iso[0] : null, rest: cutMatch(text, iso) };

  const local = LOCAL_DATE.exec(text);
  if (!local) return null;
  const [, day, month, year] = local as unknown as [string, string, string, string];
  const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return { day: isIsoDay(date) ? date : null, rest: cutMatch(text, local) };
}

/**
 * The day a MESSAGE names, explicit or relative, against the clock the turn is answered
 * at. `null` when nothing in it names a day — never today by default, which is the rule
 * both dated-fact lanes rest on: a movement dated with a day nobody wrote is exactly the
 * invention their frontiers exist to stop.
 */
export function dateInMessage(text: string, today: string): DateToken | null {
  const token = dateTokenIn(text);
  if (token !== null) return token;
  if (YESTERDAY_WORDS.test(text)) return { day: dayBefore(today), rest: text };
  if (TODAY_WORDS.test(text)) return { day: today, rest: text };
  return null;
}

/** Cut one match out of the text it was found in. */
export function cutMatch(text: string, match: RegExpExecArray): string {
  return text.slice(0, match.index) + text.slice(match.index + match[0].length);
}

/** The calendar day before `day`, through UTC so no timezone can shift it. */
export function dayBefore(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Every gap a refusal fell into, as ONE sentence.
 *
 * The shape is the point, not the punctuation: a person who has to be asked three times
 * for one movement has been asked to fill in a form badly, so each lane collects its
 * gaps and says them all at once (#1418's disease is the refusal that asks again).
 */
export function joinRefusalGaps(gaps: readonly string[], fallback: string): string {
  if (gaps.length <= 1) return gaps[0] ?? fallback;
  return `${gaps.slice(0, -1).join("; ")}; y ${gaps[gaps.length - 1]}`;
}
