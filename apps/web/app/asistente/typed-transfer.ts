/**
 * A traspaso the USER DICTATED, read by worthline itself (#1482, S5 of PRD #1393).
 *
 * The doctrine is #1418's, word for word, and it is the reason this module exists as a
 * PARSER and not as a flag on the tool's arguments: the model has the whole
 * conversation in its context, so an `amountMinor` it hands over could be a figure it
 * remembers from an unreadable spreadsheet, from a portfolio read, or from its own
 * earlier prose — and a traspaso writes TWO rows plus an inherited cost, so a figure
 * nobody wrote would move real capital between two real holdings. worthline therefore
 * reads the importe and the date off the user's own message, with no model in the
 * loop, and the lane builds from THESE figures.
 *
 * What the model still decides, because no parser can: WHICH two holdings «el fondo A»
 * and «el fondo B» are. That is an id, it has to come from a read (#1263), and the
 * card prints both names before anything is written.
 *
 * Everything ambiguous FAILS CLOSED and says which gap it fell into
 * ({@link TypedTransferGap}) — never «no te he entendido», which is the refusal a
 * person cannot act on and the disease #1418 is named after.
 *
 * What it DOES read, since #1544: the **participaciones**, when the message states
 * them («37,203 participaciones», «34,8032023 part.»). They are marked by their own
 * word, so they never compete with the figure in euros, and with them the origin's VL
 * stops being a figure the app has to supply — it is derived from the two the user
 * wrote, exactly as a buy derives its price. That is what retires the provenance
 * caveat: there is no cached price in the arithmetic to warn about.
 *
 * What it deliberately does NOT read:
 *
 * - **The two VLs.** Nobody dictates «a 12,3456 € el valor liquidativo» twice, and a
 *   figure guessed for either half would invent participaciones. Where they are still
 *   needed — a leg stated only as an importe — the builder takes them from the app's
 *   own price for that holding and the card says which it was.
 * - **A second importe** (the one that ARRIVED, #1479). Two money figures in one
 *   sentence cannot be told apart by order without guessing, so the message is refused
 *   naming both — the screen of #1480 has a field for each.
 * - **A commission.** Same reason: it is a third money figure competing with the two
 *   above, and a traspaso charged one is the case for the screen.
 */

import type { TransferPortion } from "@worthline/domain";
import type { UIMessage } from "ai";

import { isIsoDay, normalizeExtractedNumber } from "./attachment-extraction-contract";

/** One traspaso, as much of it as a message can state. */
export interface TypedTransfer {
  /** YYYY-MM-DD, always a real day, always written in the message. */
  executedAt: string;
  /**
   * How much of the origin left — an importe in céntimos, «todo», or the
   * participaciones the message stated together with their importe (#1544).
   */
  portion: TransferPortion;
}

/**
 * Why a message could not become a traspaso. Each one is a sentence the refusal can
 * say back, so the person is told what to add rather than asked the same thing again.
 */
export type TypedTransferGap =
  /** No importe and no «todo». */
  | "amount"
  /** No date. Never defaulted to today: see {@link parseTypedTransfer}. */
  | "date"
  /** Two or more figures could be the importe, and order is not evidence. */
  | "ambiguous_amount"
  /** Two or more figures are marked as participaciones, one per leg — see #1544. */
  | "ambiguous_units"
  /** «Todo» AND an importe (or participaciones): two intents for one portion. */
  | "conflicting_portion";

export type TypedTransferReading =
  | { status: "read"; transfer: TypedTransfer }
  /** Nothing was written, or what was written is ambiguous. Never a silent guess. */
  | { status: "incomplete"; missing: TypedTransferGap[] };

/**
 * What each gap says back to the person, in the words that let them fix it.
 *
 * Every one of these names the missing thing AND how to write it, because the refusal
 * this lane must never produce is the one #1418 is named after: asking again, in the
 * same words, for something the person believes they already gave. None of them says
 * «worthline no lo hace» — the traspaso HAS a route, two of them, and the messages
 * point at the one that fits (#1524's asymmetry).
 */
const GAP_MESSAGES: Record<TypedTransferGap, string> = {
  ambiguous_amount:
    "en tu mensaje hay más de una cifra y no sé cuál es el importe que se traspasó. " +
    "Escríbeme solo ése, en euros («1.018,67 €»). Si el importe que LLEGÓ al destino fue " +
    "distinto del que salió —pasa, y es normal—, eso se registra desde «Traspasar» en la " +
    "ficha de la posición de origen, que tiene un campo para cada uno",
  ambiguous_units:
    "en tu mensaje hay más de una cifra de participaciones y no sé de qué lado es cada " +
    "una. Si tienes las de los dos lados —las que salieron y las que entraron—, eso se " +
    "registra desde «Traspasar» en la ficha de la posición de origen, que tiene un campo " +
    "para cada una; por aquí dime solo las que salieron, con su importe",
  amount:
    "no he visto cuánto se ha traspasado. Escríbeme el importe en euros («1.018,67 €»), " +
    "o dime «todo» si has traspasado la posición entera",
  conflicting_portion:
    "me dices «todo» y también una cifra concreta, y son dos traspasos distintos: «todo» " +
    "vacía la posición exacta, y un importe saca esa cifra y deja el resto. Dime cuál de " +
    "los dos",
  date:
    "no he visto la fecha. Dime el día del traspaso («hoy», «ayer» o 12/08/2026): no fecho " +
    "yo un movimiento que no me has fechado",
};

/**
 * The refusal for a dictated traspaso worthline could not read, as the model relays it.
 *
 * One sentence with every gap in it, not one round trip per gap: a person who has to be
 * asked three times for one traspaso has been asked to fill in a form badly.
 */
export function typedTransferGapMessage(missing: readonly TypedTransferGap[]): string {
  const gaps = missing.map((gap) => GAP_MESSAGES[gap]);
  const listed =
    gaps.length <= 1
      ? (gaps[0] ?? GAP_MESSAGES.amount)
      : `${gaps.slice(0, -1).join("; ")}; y ${gaps[gaps.length - 1]}`;
  return (
    `Te preparo el traspaso, pero ${listed}. Lo leo de tu mensaje tal cual lo escribas: si ` +
    "me dices las participaciones que salieron («37,203 participaciones») junto al importe, " +
    "el valor liquidativo lo calculo yo con esas dos cifras; si no, uso el precio que tengo " +
    "de cada posición y te digo de cuándo es."
  );
}

/** How far into one message the parser looks, so a pasted book is bounded work. */
const MAX_SCANNED_CHARS = 20_000;

/** `YYYY-MM-DD`, fenced by digit lookarounds exactly as the balance series is. */
const ISO_DATE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/u;

/**
 * `D/M/YYYY`, `D-M-YYYY`, `D.M.YYYY`. DAY FIRST, with no attempt to detect the
 * American order — worthline is es-ES throughout and its number reader settles the
 * same ambiguity the same way (`normalizeExtractedNumber`).
 */
const LOCAL_DATE = /(?<!\d)(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})(?!\d)/u;

/**
 * A figure with money on it: «1.018,67 €», «1018,67 EUR», «500 euros».
 *
 * The currency mark is what makes this the STRONG reading, and it is tried first for
 * that reason: a message about a traspaso can carry participaciones, a percentage and
 * a VL, and only one of its figures wears a euro sign.
 */
const MARKED_MONEY = /(?<![\d.,])(\d[\d.,]*)\s*(?:€|EUR\b|euros?\b)/giu;

/** Any figure at all — the fallback reading, admitted only when there is exactly one. */
const BARE_NUMBER = /(?<![\d.,])\d[\d.,]*/gu;

/**
 * A figure marked as PARTICIPACIONES: «37,203 participaciones», «34,8032023 part.»
 * (#1544).
 *
 * Its own word is what makes it unmistakable, and it is why this reading can be added
 * without weakening the money one: the units token is cut out of the text before the
 * importe is counted, so a message with both figures is no longer ambiguous — it is
 * fully stated.
 */
const MARKED_UNITS =
  /(?<![\d.,])(\d[\d.,]*)\s*(?:participaci(?:ón|on|ones)\b|part(?:ic)?\.)/giu;

/**
 * «Todo» as an intent, in the words people actually use. It is NOT the importe that
 * happens to equal the position: only «todo» liquidates the origin exactly, leaving no
 * millionth of a participación behind (`planTransfer`).
 */
const ALL_PORTION_WORDS =
  /\b(todo|toda|todas|todos|totalidad|íntegr\w+|integr\w+|entero|entera)\b/iu;
/** «el 100 %» — kept apart because `%` is not a word character and `\b` cannot end it. */
const ALL_PORTION_PERCENT = /(?<!\d)100\s?%/u;

/** Today, and the day before it — the only two relative days a message may name. */
const TODAY_WORDS = /\b(hoy|ahora|ahora mismo|esta mañana|esta tarde)\b/iu;
const YESTERDAY_WORDS = /\bayer\b/iu;

/**
 * Read the traspaso written in `text`, against the clock the turn is being answered at.
 *
 * The date is required and never defaulted, which is the one decision here worth
 * defending: «he traspasado 1.018,67 €» with no day in it is a fact whose date only the
 * app would know, and a dated row nobody dated is exactly the invention the frontier
 * exists to stop (#1466's rule, same reasoning). «Hoy» and «ayer» count as written —
 * the person did name the day, in the words a person uses.
 *
 * The order of the two readings matters. A euro-marked figure wins outright; only when
 * there is none does a bare number count, and then only if the message holds exactly
 * ONE once the date has been cut out of it — so «traspasé 1018,67 el 12/08/2026» reads
 * cleanly while «1018,67 a 12,3456» is refused instead of resolved by position.
 */
export function parseTypedTransfer(text: string, today: string): TypedTransferReading {
  const scanned = text.slice(0, MAX_SCANNED_CHARS);
  const dated = dateIn(scanned, today);
  // The date is cut out before the figures are counted: `12/08/2026` is three numbers
  // to a scanner and would make every dated message ambiguous.
  const portion = portionIn(dated === null ? scanned : dated.rest);

  const missing: TypedTransferGap[] = [];
  if (!portion.ok) missing.push(portion.gap);
  const executedAt = dated?.date ?? null;
  if (executedAt === null) missing.push("date");

  if (!portion.ok || executedAt === null) return { missing, status: "incomplete" };
  return { status: "read", transfer: { executedAt, portion: portion.portion } };
}

/**
 * The traspaso dictated in THIS turn — the last user message and nothing else.
 *
 * Scoped to the turn, and to the user's own role, for the same two reasons as the
 * balance series: prose written by the ASSISTANT is the model quoting itself, and an
 * earlier user turn is a figure from another conversation about another traspaso. «Hoy»
 * only means something in the turn being answered.
 */
export function typedTransferInTurn(
  messages: readonly UIMessage[],
  today: string,
): TypedTransferReading {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    return parseTypedTransfer(
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => (part as { text: string }).text)
        .join("\n"),
      today,
    );
  }
  return { missing: ["amount", "date"], status: "incomplete" };
}

/** The message's date and the message with that date cut out of it. */
interface DatedText {
  /** `null` when a date-SHAPED token turned out not to be a day (#1395). */
  date: string | null;
  rest: string;
}

/**
 * The day this message names, explicit or relative.
 *
 * A date-shaped token that is not a real day (`30/02/2026`) is not «no date»: it is a
 * reading we got wrong, so it fails closed with the token cut out — the figures are
 * still read, so the refusal can name BOTH gaps at once instead of one per round trip.
 */
function dateIn(text: string, today: string): DatedText | null {
  const iso = ISO_DATE.exec(text);
  if (iso) {
    return { date: isIsoDay(iso[0]) ? iso[0] : null, rest: cut(text, iso) };
  }

  const local = LOCAL_DATE.exec(text);
  if (local) {
    const [, day, month, year] = local as unknown as [string, string, string, string];
    const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    return { date: isIsoDay(date) ? date : null, rest: cut(text, local) };
  }

  if (YESTERDAY_WORDS.test(text)) return { date: dayBefore(today), rest: text };
  if (TODAY_WORDS.test(text)) return { date: today, rest: text };
  return null;
}

function cut(text: string, match: RegExpExecArray): string {
  return text.slice(0, match.index) + text.slice(match.index + match[0].length);
}

/** The calendar day before `day`, through UTC so no timezone can shift it. */
function dayBefore(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

type PortionReading =
  | { ok: true; portion: TransferPortion }
  | { ok: false; gap: TypedTransferGap };

/**
 * How much of the origin left, or the gap that stops us knowing.
 *
 * «Todo» together with a stated figure is refused rather than resolved: they are two
 * different writes — one empties the origin exactly, the other takes a stated figure out
 * of it — and choosing between them is the app deciding what the user meant.
 *
 * The participaciones are read FIRST and cut out of the text, so the importe is counted
 * over what is left (#1544). That order is what makes the fully-stated message —
 * «37,203 participaciones (739,22 €)» — read cleanly instead of as two competing
 * figures, and it is the reading that lets the VL be derived rather than borrowed from
 * the app's price cache.
 */
function portionIn(text: string): PortionReading {
  const all = ALL_PORTION_WORDS.test(text) || ALL_PORTION_PERCENT.test(text);
  const stated = unitFiguresIn(text);
  const amounts = moneyFiguresIn(stated.rest);

  if (all && (amounts.length > 0 || stated.units.length > 0)) {
    return { gap: "conflicting_portion", ok: false };
  }
  if (all) return { ok: true, portion: { kind: "all" } };
  // One figure per leg is exactly what an extracto prints, and only the screen has a
  // field for each: which of the two a lone sentence means is not ours to pick.
  if (stated.units.length > 1) return { gap: "ambiguous_units", ok: false };
  if (amounts.length > 1) return { gap: "ambiguous_amount", ok: false };

  const [amount] = amounts;
  if (amount === undefined) return { gap: "amount", ok: false };

  const amountMinor = Math.round(amount * 100);
  if (!(amountMinor > 0) || !Number.isSafeInteger(amountMinor)) {
    return { gap: "amount", ok: false };
  }

  const [units] = stated.units;
  if (units !== undefined) {
    return { ok: true, portion: { amountMinor, kind: "units", units } };
  }
  return { ok: true, portion: { amountMinor, kind: "amount" } };
}

/** The participaciones a message states, and the message with those tokens cut out. */
interface StatedUnits {
  /** Decimal strings, in printed order. Empty when the message states none. */
  units: string[];
  rest: string;
}

/**
 * The figures marked as participaciones, and what is left to read the importe from.
 *
 * The value goes through the same number reader as every other dictated figure (es-ES
 * separators settled the same way) and back to a string: a participaciones count has
 * fewer significant digits than a double can round-trip, so nothing is lost, and the
 * rest of the pipeline speaks decimal strings.
 */
function unitFiguresIn(text: string): StatedUnits {
  const units: string[] = [];
  const scanner = new RegExp(MARKED_UNITS.source, MARKED_UNITS.flags);
  let rest = "";
  let cursor = 0;
  let match = scanner.exec(text);
  while (match !== null) {
    const value = normalizeExtractedNumber(match[1]!);
    // A token we cannot read, or a zero, is LEFT in the text: cutting it would hide it
    // from the importe reader too, and then a message with one unreadable figure would
    // look like a message with none.
    if (value !== null && value > 0) {
      units.push(String(value));
      rest += text.slice(cursor, match.index);
      cursor = match.index + match[0].length;
    }
    match = scanner.exec(text);
  }
  return { rest: rest + text.slice(cursor), units };
}

/**
 * The money figures this text states, in printed order.
 *
 * Euro-marked figures win outright; when there is none, every bare number counts, so
 * a message with two of them is ambiguous rather than read by position. A token
 * followed by `%` is dropped either way: a commission of 0 % is not an importe.
 */
function moneyFiguresIn(text: string): number[] {
  const marked = figures(text, MARKED_MONEY, (match) => match[1]!);
  if (marked.length > 0) return marked;
  return figures(text, BARE_NUMBER, (match) => match[0]);
}

function figures(
  text: string,
  pattern: RegExp,
  pick: (match: RegExpExecArray) => string,
): number[] {
  const found: number[] = [];
  // A fresh instance per call: a `g` regex carries `lastIndex` between callers.
  const scanner = new RegExp(pattern.source, pattern.flags);
  let match = scanner.exec(text);
  while (match !== null) {
    const after = text.slice(match.index + match[0].length).trimStart();
    if (!after.startsWith("%")) {
      const value = normalizeExtractedNumber(pick(match));
      if (value !== null) found.push(value);
    }
    match = scanner.exec(text);
  }
  return found;
}
