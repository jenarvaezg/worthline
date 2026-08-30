/**
 * A dated operation the USER DICTATED, read by worthline itself (#1466).
 *
 * The sibling of `typed-balance-series.ts` and `typed-transfer.ts`, and it exists for
 * the reason those two do, word for word. The document-only frontier of #1374 was
 * raised against the MODEL inventing figures — it filled a reconcile's mandatory
 * `value` with a snapshot of the portfolio and then explained the invented figure to
 * the user — and that reasoning says nothing about a fact the USER typed. Jorge's
 * message carried the four things an operation needs (the instrument, the quantity,
 * the amount and the day) and still hit «súbeme el justificante», so the doctrine of
 * #1418 applies here: a frontier raised against the model's invention must not close
 * the door on what the user writes; **to let typed figures in, parse them**.
 *
 * So this module is a PARSER and not a flag on the tool's arguments. A flag saying
 * «the user said so» would be worth nothing: the model has the whole conversation in
 * its context, so it could «remember» a figure and present it as typed. worthline
 * reads the operation off the user's own message with no model in the loop, and the
 * lane builds from THESE figures.
 *
 * What it returns is deliberately close to {@link ExtractedHoldingEvent}
 * ({@link holdingEventFromTyped} completes it): from there the whole existing chain is
 * reused intact — `operation-terms.ts` and its invariant
 * (`importe = participaciones × precio + comisión`), the card with its provenance, and
 * every guard in `operation-proposals.ts` (divisa, sobreventa, duplicado, fecha
 * futura, fuente conectada, ISIN contradictorio).
 *
 * What it deliberately does NOT read:
 *
 * - **The direction.** «He comprado» is read, but only as a VETO: the `kind` stays the
 *   model's call and is never defaulted, exactly as it is on the document lane. What
 *   the message can do is contradict it ({@link typedDirectionConflict}).
 * - **The date, when it is not written.** Silence is not «hoy»: an operation dated with
 *   a day nobody wrote is precisely the invention the frontier exists to stop.
 * - **The currency, when it is not marked.** It is left `null` and the builder takes the
 *   holding's, saying so on the card — never assumed in silence (#1401 was the book
 *   adding dollars as euros).
 */

import { multiplyToMinor } from "@worthline/domain";
import type { UIMessage } from "ai";

import {
  type ExtractedHoldingEvent,
  isIsoDay,
  isValidIsin,
  normalizeExtractedNumber,
} from "./attachment-extraction-contract";
import {
  OPERATION_DOCUMENT_REQUIRED_MESSAGE,
  type OperationFactClaim,
  type OperationFactVoice,
  type OperationFrontierError,
  type OperationKindClaim,
  operationClaimMismatches,
} from "./operation-document-frontier";

/** One dated operation, as much of it as a message can state. */
export interface TypedHoldingEvent {
  /** YYYY-MM-DD, always a real day, always written in the message. */
  executedAt: string;
  /** Participaciones as a decimal string, when the message states them. */
  units?: string;
  /** The total importe, in major units, when the message states it. */
  amount?: number;
  /** The price per participación, in major units, when the message states it. */
  pricePerUnit?: number;
  /** The commission, in major units — read by its own word, never by position. */
  fees?: number;
  /** The currency the user WROTE, or null when they marked none. */
  currency: string | null;
  /** The instrument the message names by its ISIN, when it names one. */
  isin?: string;
  /** The direction the message states unmistakably, or null. A veto, never a default. */
  direction: "in" | "out" | null;
  /** The resulting total the user declares («tengo 21») — an optional witness. */
  declaredTotalUnits?: string;
}

/**
 * Why a message could not become an operation. Each one is a sentence the refusal can
 * say back, so the person is told what to add rather than asked the same thing again.
 */
export type TypedHoldingEventGap =
  /** No quantity of participaciones, and no way to derive one. */
  | "units"
  /** Neither a total importe nor a unit price. */
  | "money"
  /** No date. Never defaulted to today. */
  | "date"
  /** Two or more figures could be the importe, and order is not evidence. */
  | "ambiguous_amount"
  /** Two or more figures are marked as the operation's participaciones. */
  | "ambiguous_units";

export type TypedHoldingEventReading =
  | { status: "read"; event: TypedHoldingEvent }
  /** Something was written, but not enough — or not unambiguously. */
  | { status: "incomplete"; missing: TypedHoldingEventGap[] }
  /**
   * The message states no operation at all. Kept apart from `incomplete` because the
   * two deserve different answers: a half-written operation is told what is missing, a
   * message about something else is routed to the justificante and to the screen.
   */
  | { status: "absent" };

/** What each gap says back to the person, in the words that let them fix it. */
const GAP_MESSAGES: Record<TypedHoldingEventGap, string> = {
  ambiguous_amount:
    "en tu mensaje hay más de una cifra en euros y no sé cuál es el importe de la " +
    "operación. Escríbeme sólo ése («312,55 €»), y si hubo comisión dímela con su " +
    "palabra («1,50 € de comisión»)",
  ambiguous_units:
    "en tu mensaje hay más de una cifra de participaciones y no sé cuál es la de esta " +
    "operación. Dime sólo las que has comprado o vendido; el total que te queda, si " +
    "quieres, dímelo aparte («y ahora tengo 21»)",
  date: "no he visto la fecha. Dime el día («hoy», «ayer» o 12/08/2026): no fecho yo una operación que no me has fechado",
  money:
    "no he visto el dinero. Dime el importe total («por 312,55 €») o el precio por " +
    "participación («a 52,09 € cada una»)",
  units:
    "no he visto cuántas participaciones son. Dímelas («6 participaciones»): sin ellas " +
    "no puedo anotar la operación, porque encajarla como una sola participación al " +
    "importe revalorizaría la posición al precio de UNA",
};

/**
 * The refusal for a dictated operation worthline could not read, as the model relays
 * it. One sentence with every gap in it, not one round trip per gap.
 */
export function typedHoldingEventGapMessage(
  missing: readonly TypedHoldingEventGap[],
): string {
  const gaps = missing.map((gap) => GAP_MESSAGES[gap]);
  const listed =
    gaps.length <= 1
      ? (gaps[0] ?? GAP_MESSAGES.units)
      : `${gaps.slice(0, -1).join("; ")}; y ${gaps[gaps.length - 1]}`;
  return (
    `Te anoto la operación sin justificante, pero ${listed}. Lo leo de tu mensaje tal cual ` +
    "lo escribas: instrumento, participaciones, importe y fecha."
  );
}

/** How far into one message the parser looks, so a pasted book is bounded work. */
const MAX_SCANNED_CHARS = 20_000;

/** `YYYY-MM-DD`, fenced by digit lookarounds exactly as the sibling parsers are. */
const ISO_DATE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/u;

/** `D/M/YYYY`, `D-M-YYYY`, `D.M.YYYY`. DAY FIRST, es-ES throughout. */
const LOCAL_DATE = /(?<!\d)(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})(?!\d)/u;

/** Today, and the day before it — the only two relative days a message may name. */
const TODAY_WORDS = /\b(hoy|ahora|ahora mismo|esta mañana|esta tarde)\b/iu;
const YESTERDAY_WORDS = /\bayer\b/iu;

/**
 * An ISIN-SHAPED token. Cut out of the text before any figure is counted, and that is
 * not cosmetic: `IE00B43VDT70` holds `00`, `43` and `70`, so a message naming its fund
 * properly would otherwise read as a message full of numbers.
 */
const ISIN_TOKEN = /(?<![A-Za-z0-9])[A-Za-z]{2}[A-Za-z0-9]{9}[0-9](?![A-Za-z0-9])/gu;

/**
 * A figure marked as PARTICIPACIONES: «6 participaciones», «3 part.», «10 títulos».
 * Its own word is what makes it unmistakable, so it never competes with the importe.
 */
const MARKED_UNITS =
  /(?<![\d.,])(\d[\d.,]*)\s*(?:participaci(?:ón|on|ones)\b|part(?:ic)?\.|t[íi]tulos?\b|acciones?\b)/giu;

/**
 * What turns a quantity into the WITNESS instead of the operation's own: a verb of
 * having, in the words people use. «Sumando esas 6, tengo 21» states one operation and
 * one resulting total, and reading the second as the first would double the write.
 */
const HOLDING_VERBS =
  /(?<!\p{L})(?:tengo|tienes|tenemos|tener|quedan|queda|quedo|acumul\p{L}*|son ya|ahora son|pasan a ser|paso a)(?!\p{L})/iu;

/** How far back a quantity looks for the verb that makes it the witness. */
const WITNESS_WINDOW = 40;

/**
 * A figure marked as the price PER PARTICIPACIÓN: «a 52,09 € cada una»,
 * «52,09 €/participación», «52,09 € por título».
 */
const MARKED_UNIT_PRICE =
  /(?<![\d.,])(\d[\d.,]*)\s*(?:€|EUR\b|euros?\b|\$|USD\b|£|GBP\b|CHF\b)?\s*(?:\/\s*(?:participaci\w*|part\b|acci\w+|t[íi]tul\w+|unidad)|(?:por|cada)\s+(?:participaci\w*|part\.|acci\w+|t[íi]tul\w+|unidad|una|uno)|c\/u)/giu;

/** A commission, marked by its own word — before or after the figure. */
const FEES_BEFORE =
  /(?<![\d.,])(\d[\d.,]*)\s*(?:€|EUR\b|euros?\b|\$|USD\b|£|GBP\b|CHF\b)?\s*(?:de\s+|en\s+)?(?:comisi(?:ón|on|ones)|corretaje|gastos)\b/giu;
const FEES_AFTER =
  /(?:comisi(?:ón|on|ones)|corretaje|gastos)\s*(?:de|:)?\s*(\d[\d.,]*)/giu;

/** A figure with money on it: «312,55 €», «312,55 EUR», «500 euros». */
const MARKED_MONEY =
  /(?<![\d.,])(\d[\d.,]*)\s*(?:€|EUR\b|euros?\b|\$|USD\b|d[óo]lares?\b|£|GBP\b|CHF\b)/giu;

/** Any figure at all — the fallback reading, admitted only when there is exactly one. */
const BARE_NUMBER = /(?<![\d.,])\d[\d.,]*/gu;

/** The currency the message MARKS, if it marks one. Never defaulted here. */
const CURRENCY_MARKS: readonly [RegExp, string][] = [
  [/€|\bEUR\b|\beuros?\b/iu, "EUR"],
  [/\$|\bUSD\b|\bd[óo]lares?\b/iu, "USD"],
  [/£|\bGBP\b|\blibras?\b/iu, "GBP"],
  [/\bCHF\b|\bfrancos?\b/iu, "CHF"],
];

/**
 * The verbs that pin a direction. Both present at once vetoes nothing.
 *
 * Fenced with `\p{L}` lookarounds and not with `\b`, which is the detail that decides
 * whether «vendí» is read at all: `\b` is an ASCII-word boundary, so it does not close
 * after an accented letter. `compr` excludes «comprobar» and «comprender», the two
 * ordinary words that would otherwise read as a purchase.
 */
const BUY_VERBS =
  /(?<!\p{L})(?:compr(?!ob|en)\p{L}*|adquir\p{L}*|aport\p{L}*|suscri\p{L}*|invert\p{L}*|invertí|invirti\p{L}*)/iu;
const SELL_VERBS =
  /(?<!\p{L})(?:vend\p{L}*|vendí|reembols\p{L}*|rescat\p{L}*|desinvert\p{L}*)/iu;

/**
 * The label the composed event carries. It is not shown as «what the document says» —
 * the card prints what worthline READ instead — but the contract requires one, and a
 * label that names the provenance is the honest value for it.
 */
export const TYPED_OPERATION_LABEL = "Operación que me has dictado en el chat";

/** The document name a dictated operation is recorded against. */
export const TYPED_OPERATION_DOCUMENT_NAME = "operación-dictada-en-el-chat";

/**
 * Read the operation written in `text`, against the clock the turn is answered at.
 *
 * The order of the readings is what makes the message of #1466 legible: the ISIN goes
 * first (its digits are not figures), then the date (`12/08/2026` is three numbers to a
 * scanner), then the commission and the participaciones — each marked by its own word —
 * and only what is left competes to be the importe.
 */
export function parseTypedHoldingEvent(
  text: string,
  today: string,
): TypedHoldingEventReading {
  const scanned = text.slice(0, MAX_SCANNED_CHARS);
  const withoutIsin = isinIn(scanned);
  const dated = dateIn(withoutIsin.rest, today);
  const body = dated === null ? withoutIsin.rest : dated.rest;

  const fees = feesIn(body);
  const quantities = unitFiguresIn(fees.rest);
  const prices = figuresIn(quantities.rest, MARKED_UNIT_PRICE, (match) => match[1]!);
  const amounts = moneyFiguresIn(prices.rest);

  const [units] = quantities.units;
  const [pricePerUnit] = prices.values;
  const [amount] = amounts;

  const statesNothing =
    quantities.units.length === 0 &&
    prices.values.length === 0 &&
    amounts.length === 0 &&
    fees.value === undefined;
  if (statesNothing) return { status: "absent" };

  const missing: TypedHoldingEventGap[] = [];
  if (quantities.units.length > 1) missing.push("ambiguous_units");
  if (amounts.length > 1) missing.push("ambiguous_amount");
  if (missing.length === 0) {
    // Without a quantity the chain can still derive one — but only from the two money
    // figures together. A lone importe would have to be encoded as «1 participación al
    // importe», which the next ripple revalues to ONE share's price (ADR 0067, #1325).
    if (units === undefined && !(amount !== undefined && pricePerUnit !== undefined)) {
      missing.push("units");
    }
    if (amount === undefined && pricePerUnit === undefined) missing.push("money");
  }
  const executedAt = dated?.date ?? null;
  if (executedAt === null) missing.push("date");

  if (missing.length > 0 || executedAt === null) {
    return { missing, status: "incomplete" };
  }

  return {
    event: {
      currency: currencyIn(scanned),
      direction: directionIn(scanned),
      executedAt,
      ...(units === undefined ? {} : { units }),
      ...(amount === undefined ? {} : { amount }),
      ...(pricePerUnit === undefined ? {} : { pricePerUnit }),
      ...(fees.value === undefined ? {} : { fees: fees.value }),
      ...(withoutIsin.isin === undefined ? {} : { isin: withoutIsin.isin }),
      ...(quantities.declaredTotal === undefined
        ? {}
        : { declaredTotalUnits: quantities.declaredTotal }),
    },
    status: "read",
  };
}

/**
 * The operation dictated in THIS turn — the last user message and nothing else.
 *
 * Scoped to the turn, and to the user's own role, for the same two reasons as its
 * siblings: prose written by the ASSISTANT is the model quoting itself, and an earlier
 * user turn is a figure from another conversation about another operation. «Ahora» only
 * means something in the turn being answered.
 */
export function typedHoldingEventInTurn(
  messages: readonly UIMessage[],
  today: string,
): TypedHoldingEventReading {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    return parseTypedHoldingEvent(
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => (part as { text: string }).text)
        .join("\n"),
      today,
    );
  }
  return { status: "absent" };
}

/**
 * The message's own words against the direction the MODEL chose, as a veto.
 *
 * Symmetric to the document lane's `DIRECTION_BY_EVENT_KIND`: the message cannot pick
 * the direction (silence is not «compra»), but when it states one unmistakably a model
 * that passes the opposite is reading something other than what the person wrote.
 */
export function typedDirectionConflict(
  event: TypedHoldingEvent,
  kind: OperationKindClaim,
): string | null {
  const claimed = kind === "sell" ? "out" : "in";
  if (event.direction === null || event.direction === claimed) return null;
  const wrote = event.direction === "in" ? "una compra" : "una venta";
  const asked = kind === "sell" ? "una venta" : "una compra";
  return (
    `Tu mensaje dice ${wrote} y yo iba a anotar ${asked}: no lo cambio por mi cuenta. ` +
    "Dime si compraste o vendiste y lo preparo."
  );
}

/**
 * The event the existing chain builds from, with the currency resolved.
 *
 * The importe is the one figure that may be DERIVED here, and only from two figures the
 * person wrote: `participaciones × precio`. It is the same arithmetic the ledger will
 * redo in reverse (`operation-terms.ts` derives the price back from the amount), so
 * nothing is invented — but the card says so, because a figure the user did not type is
 * a figure they have to be able to check.
 */
export function holdingEventFromTyped(
  event: TypedHoldingEvent,
  currency: string,
): ExtractedHoldingEvent {
  const amount =
    event.amount ??
    // Reached only when both were read: the parser refuses a message with neither.
    derivedAmount(event.units ?? "0", event.pricePerUnit ?? 0, event.fees);
  return {
    amount,
    currency,
    date: event.executedAt,
    // `other` is what a securities operation is in this contract (#1316), and it is
    // deliberately not `deposit`/`withdrawal`: those two pin a direction, and the
    // direction here is the model's call vetoed by {@link typedDirectionConflict}.
    kind: "other",
    label: TYPED_OPERATION_LABEL,
    ...(event.units === undefined ? {} : { units: Number(event.units) }),
    ...(event.pricePerUnit === undefined
      ? {}
      : { pricePerUnit: { amount: event.pricePerUnit, currency } }),
    ...(event.fees === undefined ? {} : { fees: { amount: event.fees, currency } }),
    ...(event.isin === undefined ? {} : { isin: event.isin }),
  };
}

/** `participaciones × precio + comisión`, through the money seam and back to major units. */
function derivedAmount(units: string, price: number, fees: number | undefined): number {
  const grossMinor = multiplyToMinor(units, String(price));
  const feesMinor = fees === undefined ? 0 : multiplyToMinor(String(fees), "1");
  return (grossMinor + feesMinor) / 100;
}

/** The instrument the message names, and the message with every ISIN token cut out. */
function isinIn(text: string): { isin?: string; rest: string } {
  let isin: string | undefined;
  const rest = text.replace(ISIN_TOKEN, (token) => {
    if (!isValidIsin(token)) return token;
    isin ??= token.toUpperCase();
    return " ";
  });
  return { rest, ...(isin === undefined ? {} : { isin }) };
}

/** The message's date and the message with that date cut out of it. */
interface DatedText {
  /** `null` when a date-SHAPED token turned out not to be a day (#1395). */
  date: string | null;
  rest: string;
}

/**
 * The day this message names, explicit or relative. A date-shaped token that is not a
 * real day (`30/02/2026`) fails closed with the token cut out, so the refusal can name
 * every gap at once instead of one per round trip.
 */
function dateIn(text: string, today: string): DatedText | null {
  const iso = ISO_DATE.exec(text);
  if (iso) return { date: isIsoDay(iso[0]) ? iso[0] : null, rest: cut(text, iso) };

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

/** The commission the message states by its own word, and what is left to read. */
function feesIn(text: string): { value?: number; rest: string } {
  for (const pattern of [FEES_BEFORE, FEES_AFTER]) {
    const found = figuresIn(text, pattern, (match) => match[1]!);
    const [value] = found.values;
    if (value !== undefined) return { rest: found.rest, value };
  }
  return { rest: text };
}

/** The participaciones a message states: the operation's, and the declared total. */
interface StatedUnits {
  /** Decimal strings, in printed order. Empty when the message states none. */
  units: string[];
  /** The witness, when a verb of having marks one («y ahora tengo 21»). */
  declaredTotal?: string;
  rest: string;
}

/**
 * The quantities of participaciones, split into the operation's own and the WITNESS.
 *
 * A quantity preceded by a verb of having is the total the person says they end up
 * with — the figure #1422's rule checks against the book and never writes. Everything
 * else is the operation's own, and two of those are ambiguous rather than ordered.
 */
function unitFiguresIn(text: string): StatedUnits {
  const units: string[] = [];
  let declaredTotal: string | undefined;
  const scanner = new RegExp(MARKED_UNITS.source, MARKED_UNITS.flags);
  let rest = "";
  let cursor = 0;
  let match = scanner.exec(text);
  while (match !== null) {
    const value = normalizeExtractedNumber(match[1]!);
    // A token we cannot read, or a zero, is LEFT in the text: cutting it would hide it
    // from the importe reader too, and a message with one unreadable figure would then
    // look like a message with none.
    if (value !== null && value > 0) {
      const before = text.slice(Math.max(0, match.index - WITNESS_WINDOW), match.index);
      if (HOLDING_VERBS.test(before)) declaredTotal ??= String(value);
      else units.push(String(value));
      rest += text.slice(cursor, match.index);
      cursor = match.index + match[0].length;
    }
    match = scanner.exec(text);
  }
  return {
    rest: rest + text.slice(cursor),
    units,
    ...(declaredTotal === undefined ? {} : { declaredTotal }),
  };
}

/**
 * The money figures this text states, in printed order. Euro-marked figures win
 * outright; when there is none, every bare number counts, so a message with two of them
 * is ambiguous rather than read by position.
 */
function moneyFiguresIn(text: string): number[] {
  const marked = figuresIn(text, MARKED_MONEY, (match) => match[1]!);
  if (marked.values.length > 0) return marked.values;
  return figuresIn(text, BARE_NUMBER, (match) => match[0]).values;
}

/** Every figure a pattern matches, and the text with those tokens cut out. */
function figuresIn(
  text: string,
  pattern: RegExp,
  pick: (match: RegExpExecArray) => string,
): { values: number[]; rest: string } {
  const values: number[] = [];
  // A fresh instance per call: a `g` regex carries `lastIndex` between callers.
  const scanner = new RegExp(pattern.source, pattern.flags);
  let rest = "";
  let cursor = 0;
  let match = scanner.exec(text);
  while (match !== null) {
    const after = text.slice(match.index + match[0].length).trimStart();
    const value = after.startsWith("%") ? null : normalizeExtractedNumber(pick(match));
    if (value !== null) {
      values.push(value);
      rest += text.slice(cursor, match.index);
      cursor = match.index + match[0].length;
    }
    match = scanner.exec(text);
  }
  return { rest: rest + text.slice(cursor), values };
}

/** The currency the message marks, or null when it marks none. */
function currencyIn(text: string): string | null {
  for (const [pattern, code] of CURRENCY_MARKS) {
    if (pattern.test(text)) return code;
  }
  return null;
}

/** The direction the message states unmistakably, or null when it states both or none. */
function directionIn(text: string): "in" | "out" | null {
  const buys = BUY_VERBS.test(text);
  const sells = SELL_VERBS.test(text);
  if (buys === sells) return null;
  return buys ? "in" : "out";
}

/** The two words the mismatch sentences need when the fact came off the message. */
const MESSAGE_VOICE: OperationFactVoice = {
  of: "del mensaje",
  subject: "el mensaje",
};

/**
 * A figure relayed by the model contradicts what the user typed. Mirrors
 * `operationFactNotInDocumentMessage`, and for the same reason: a refusal that does not
 * name the real value invites the same guess again.
 */
export function operationFactNotInMessageMessage(mismatches: readonly string[]): string {
  return (
    `Esto no es lo que dice el mensaje del usuario: ${mismatches.join("; ")}. ` +
    "No anoto una operación con cifras que no salgan de él: las leo yo de lo que ha " +
    "escrito. Pásame los datos tal cual los ha escrito, o pídele el justificante."
  );
}

export type TypedOperationResolution =
  | { ok: true; event: TypedHoldingEvent }
  | { ok: false; error: OperationFrontierError };

/**
 * Resolve the fact a DICTATED operation will be built from — the typed lane's half of
 * `resolveOperationEvent`, and deliberately shaped like it.
 *
 * The result is always what worthline READ: the claim only says which holding and which
 * direction, and a claim that disagrees fails the whole call. Two refusals are the
 * lane's own — a message that states no operation is routed to both vías, and a
 * half-written one is told which figure is missing — because «no te he entendido» is
 * the answer #1418 is named after.
 */
export function resolveTypedOperationEvent(
  claim: OperationFactClaim,
  reading: TypedHoldingEventReading | undefined,
): TypedOperationResolution {
  if (reading === undefined || reading.status === "absent") {
    return {
      error: {
        error: "operation_document_required",
        message: OPERATION_DOCUMENT_REQUIRED_MESSAGE,
      },
      ok: false,
    };
  }
  if (reading.status === "incomplete") {
    return {
      error: {
        error: "operation_fact_incomplete_in_message",
        message: typedHoldingEventGapMessage(reading.missing),
      },
      ok: false,
    };
  }

  const { event } = reading;
  const conflict = typedDirectionConflict(event, claim.kind);
  if (conflict !== null) {
    return {
      error: { error: "operation_kind_contradicts_message", message: conflict },
      ok: false,
    };
  }

  // The comparison runs over the event as it will be COMPOSED, so the model is checked
  // against the very figures the ledger would receive — including the importe derived
  // from `participaciones × precio`. The currency is the one place the two lanes differ:
  // when the user marked none there is nothing to contradict, so the claim's currency is
  // dropped from the check rather than measured against a placeholder (#1401 is about
  // never assuming a currency in silence, and inventing one HERE to refuse with would be
  // the same sin wearing a guard's clothes).
  const currency = event.currency ?? claim.currency?.trim().toUpperCase() ?? "EUR";
  const checked: OperationFactClaim =
    event.currency === null ? { ...claim, currency: undefined } : claim;
  const mismatches = operationClaimMismatches(
    checked,
    holdingEventFromTyped(event, currency),
    MESSAGE_VOICE,
  );
  if (mismatches.length > 0) {
    return {
      error: {
        error: "operation_fact_not_in_message",
        message: operationFactNotInMessageMessage(mismatches),
      },
      ok: false,
    };
  }
  return { event, ok: true };
}
