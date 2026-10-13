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
 *
 * And what it reads since #1794: the bank's confirmation PASTED as it comes, through the
 * label reader of #1751 ({@link ../typed-operation-receipt}) — the same one the dictated
 * operation uses. A table pairs each figure with its own label, so the four euro
 * figures of a confirmation are no longer four candidates for one importe: the importe
 * is the gross, the day is «Fecha Operación» and never «Fecha Valor», and a commission
 * is still the case for the screen — now said as such rather than as ambiguity. The
 * participaciones are the ones that LEFT, as ever, unless the paper is a suscripción:
 * then they are the ones that ARRIVED.
 */

import type { TransferPortion } from "@worthline/domain";
import type { UIMessage } from "ai";

import { normalizeExtractedNumber } from "./attachment-extraction-contract";
import { proposalCardInPart } from "./proposal-card-presence";
import {
  dateInMessage,
  joinRefusalGaps,
  MAX_SCANNED_CHARS,
  withoutSecurityIds,
} from "./typed-message-reading";
import {
  type OperationReceiptFigures,
  operationReceiptFigures,
} from "./typed-operation-receipt";

/** One traspaso, as much of it as a message can state. */
export interface TypedTransfer {
  /** YYYY-MM-DD, always a real day, always written in the message. */
  executedAt: string;
  /**
   * How much of the origin left — an importe in céntimos, «todo», or the
   * participaciones the message stated together with their importe (#1544).
   */
  portion: TransferPortion;
  /**
   * The participaciones that ARRIVED in the destination, when a pasted suscripción
   * states them (#1794). Absent everywhere else: a dictated sentence states one count,
   * and it is the one that left.
   */
  destinationUnits?: string;
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
  | "conflicting_portion"
  /**
   * A pasted confirmation that charged a commission (#1794): the importe that left and
   * the one that arrived differ, and only the screen has a field for each.
   */
  | "fee"
  /**
   * A pasted figure like «37.203» whose block never says whether its point is the
   * decimal or the thousands (#1794): no other figure of the paper settles it, so the
   * app does not pick.
   */
  | "unsettled_decimal";

export type TypedTransferReading =
  | {
      status: "read";
      transfer: TypedTransfer;
      /**
       * The text of the EARLIER user message the figures were read from (#1798), when
       * the turn's own message stated nothing about a traspaso — «sí, procede». Absent
       * when they come from the turn's own message: the card says where they came from
       * only when it is not the obvious place.
       */
      earlierMessage?: string;
    }
  /** Something was written, but not enough — or not unambiguously. Never a silent guess. */
  | {
      status: "incomplete";
      missing: TypedTransferGap[];
      /** The figure as printed, when the gap is `unsettled_decimal`: the refusal names it. */
      unsettledFigure?: string;
    }
  /**
   * The message states nothing about a traspaso: no figure, no date, no «todo», no
   * legible pasted block (#1798). Kept apart from `incomplete` because it is the one
   * reading that lets the walk over the conversation go on to an earlier message — a
   * half-written traspaso is told what it is missing, «vale, gracias» is not.
   */
  | { status: "absent" };

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
  fee:
    "lo que me has pegado trae una comisión, y un traspaso con comisión no lo anoto a " +
    "medias desde el chat: regístralo desde «Traspasar» en la ficha de la posición de " +
    "origen, que tiene un campo para cada cifra",
  unsettled_decimal:
    "en lo que me has pegado hay una cifra con tres decimales tras un punto o una coma, " +
    "y ninguna otra del bloque dice si ese signo es el decimal o el de los miles",
};

/** {@link GAP_MESSAGES}' `unsettled_decimal`, naming the figure it could not settle. */
function unsettledDecimalMessage(figure: string): string {
  const [whole, decimals] = figure.split(/[.,]/u) as [string, string];
  return (
    `en lo que me has pegado no sé leer «${figure}»: puede ser ${whole},${decimals} o ` +
    `${whole}${decimals}, y ninguna otra cifra del bloque dice si ese signo es el decimal ` +
    "o el de los miles. Escríbemelo en una frase con la fecha, el importe y esa cifra con " +
    `coma decimal («el 14/08/2026, ${whole},${decimals} participaciones, 739,22 €»)`
  );
}

/**
 * The refusal for a dictated traspaso worthline could not read, as the model relays it.
 *
 * One sentence with every gap in it, not one round trip per gap: a person who has to be
 * asked three times for one traspaso has been asked to fill in a form badly.
 */
export function typedTransferGapMessage(
  missing: readonly TypedTransferGap[],
  /** The figure behind an `unsettled_decimal` gap, as printed (#1794). */
  unsettledFigure?: string,
): string {
  // A commission is not something to write again: the way out is the screen, so the
  // sentence about how the chat reads a message would point the wrong way (#1794).
  if (missing.includes("fee")) return `Te preparo el traspaso, pero ${GAP_MESSAGES.fee}.`;
  const listed = joinRefusalGaps(
    missing.map((gap) =>
      gap === "unsettled_decimal" && unsettledFigure !== undefined
        ? unsettledDecimalMessage(unsettledFigure)
        : GAP_MESSAGES[gap],
    ),
    GAP_MESSAGES.amount,
  );
  return (
    `Te preparo el traspaso, pero ${listed}. Lo leo de tu mensaje tal cual lo escribas: si ` +
    "me dices las participaciones que salieron («37,203 participaciones») junto al importe, " +
    "el valor liquidativo lo calculo yo con esas dos cifras; si no, uso el precio que tengo " +
    "de cada posición y te digo de cuándo es."
  );
}

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

/**
 * «Todo» that is ASSENT and not the participaciones (#1798, decided with Jose): «vale, todo
 * claro, procede», «todo bien», «todo correcto». Cut out before the portion is read, so
 * the «sí, procede» of someone agreeing reaches back to the figures they wrote instead
 * of stopping the walk as a «todo» with no day.
 *
 * A short list on purpose, and not a rule about what may follow «todo»: an assent missed
 * here fails CLOSED (the turn reads as «todo» and is asked for its day), while a «todo»
 * wrongly taken for assent would reach back to an earlier importe the person just
 * replaced with the whole position.
 */
const ASSENT_TODO =
  /\btodo\s+(?:claro|bien|correcto|ok|okay|perfecto|listo|en\s+orden|entendido|conforme)\b/giu;

/**
 * «Ahora», as the traspaso reads it: not a day (#1798). The shared reader takes it for
 * today, which is right for «he comprado ahora»; in this lane it is far likelier to be
 * «¿lo ves ahora?», and as a date it stopped the walk over the conversation with a
 * traspaso missing its importe. A traspaso done today is «hoy» — the person names it.
 */
const NOT_A_DAY = /\bahora(?:\s+mismo)?\b/giu;

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
  // A PASTED confirmation is read by its labels FIRST (#1794), for the reason the
  // operation's reader gave (#1751): what the prose reader says about a table is
  // `ambiguous_amount` — a refusal, not a miss — so there would be no failure to fall
  // through from. `null` means this text is not a table, and everything below is
  // untouched.
  const receipt = operationReceiptFigures(scanned);
  if (receipt !== null) return receiptReading(receipt, scanned, today);
  // The identifiers go first (#1798): a person who types the destination's ISIN so the
  // assistant can find it has written no figure, and a message of «todo» naming its
  // fund by ISIN is not «todo» plus an importe. So do the two words this lane reads
  // differently from the shared reader: «ahora» names no day, and «todo claro» no
  // portion.
  const prose = withoutSecurityIds(scanned)
    .replace(NOT_A_DAY, " ")
    .replace(ASSENT_TODO, " ");
  const dated = dateInMessage(prose, today);
  // The date is cut out before the figures are counted: `12/08/2026` is three numbers
  // to a scanner and would make every dated message ambiguous.
  const portion = portionIn(dated === null ? prose : dated.rest);
  // Not a single thing a traspaso is made of: this message is about something else
  // («sí, procede», «vale», «¿lo ves?»), and saying it lacks an importe and a date would
  // be answering a question nobody asked in it (#1798).
  if (dated === null && !portion.ok && portion.statesNothing) return { status: "absent" };

  const missing: TypedTransferGap[] = [];
  if (!portion.ok) missing.push(portion.gap);
  const executedAt = dated?.day ?? null;
  if (executedAt === null) missing.push("date");

  if (!portion.ok || executedAt === null) return { missing, status: "incomplete" };
  return { status: "read", transfer: { executedAt, portion: portion.portion } };
}

/** A paper that prints the day its money settled: «Fecha Valor», «Fecha de valor». */
const VALUE_DATE = /fecha\s+(?:de\s+)?valor\b/iu;

/**
 * The traspaso a PASTED confirmation states (#1794).
 *
 * Deliberately the same {@link TypedTransferReading} the prose reader returns, gaps
 * included: a paste with no importe is told the same sentence as a message that never
 * wrote one, because it is the same thing missing. What it does NOT inherit is the two
 * ambiguity gaps — a table pairs each figure with its own label, so there is nothing
 * left to be ambiguous about, which is the whole reason this door exists.
 */
function receiptReading(
  figures: OperationReceiptFigures,
  scanned: string,
  today: string,
): TypedTransferReading {
  // A commission, alone: the other gaps would be asking for figures the chat is not
  // going to write anyway. Zero is not a commission — the block prints it on every
  // traspaso, charged or not.
  if (figures.fees !== undefined && figures.fees !== 0) {
    return { missing: ["fee"], status: "incomplete" };
  }
  // A figure the traspaso stands on whose decimal mark the paper never settled
  // («37.203» in a block with no other figure to say, #1794): named, never guessed. The
  // VL is not one of them — this lane derives its own, and never reads the printed one.
  const unsettled = figures.unsettled?.find((figure) => figure.field !== "price");
  if (unsettled !== undefined) {
    return {
      missing: ["unsettled_decimal"],
      status: "incomplete",
      unsettledFigure: unsettled.printed,
    };
  }
  // «Fecha Operación» wins; a paper that labels no date falls back to the day the
  // message names, and silence is still never «hoy». Except when the paper prints a
  // «Fecha Valor»: then any loose date in it may be that one, the day the money settled
  // and not the day it moved, so the gap is named instead of a day borrowed.
  const executedAt =
    figures.executedAt ??
    (VALUE_DATE.test(scanned)
      ? null
      : (dateInMessage(scanned.replace(NOT_A_DAY, " "), today)?.day ?? null));
  // The importe a traspaso stands on: the gross when the paper prints one, else the
  // efectivo. The two coincide here — a commission was refused above.
  const amount = figures.grossAmount ?? figures.netAmount;
  const amountMinor = amount === undefined ? Number.NaN : Math.round(amount * 100);

  const missing: TypedTransferGap[] = [];
  if (!(amountMinor > 0) || !Number.isSafeInteger(amountMinor)) missing.push("amount");
  if (executedAt === null) missing.push("date");
  if (missing.length > 0 || executedAt === null) return { missing, status: "incomplete" };

  const { units } = figures;
  if (units === undefined) {
    return {
      status: "read",
      transfer: { executedAt, portion: { amountMinor, kind: "amount" } },
    };
  }
  // The paper of the half that ARRIVED: its participaciones are the destination's,
  // stated, and the origin's are still divided at its own price — the card says which
  // price that was. Every other paper — a reembolso, or one that names neither — states
  // the participaciones that LEFT, which is what this lane has always read them as
  // (#1544).
  if (confirmsArrival(figures, scanned)) {
    return {
      status: "read",
      transfer: {
        destinationUnits: units,
        executedAt,
        portion: { amountMinor, kind: "amount" },
      },
    };
  }
  return {
    status: "read",
    transfer: { executedAt, portion: { amountMinor, kind: "units", units } },
  };
}

/** A suscripción, as a bank abbreviates it: «SUSCR.POR TRASPASO I», «SUSCRIPCION I.I.C.». */
const SUBSCRIPTION = /(?<!\p{L})suscr/iu;
/** A reembolso, the half that left: «REEMB.POR TRASPASO I», «rescate». */
const REDEMPTION = /(?<!\p{L})(?:reemb|rescat)/iu;

/**
 * Whether the pasted paper confirms the half that ARRIVED (#1794).
 *
 * The name printed beside «Operación» decides when there is one: it is the paper's own
 * word for itself, and the prose around a paste («te pego el reembolso») can be wrong
 * about which half was copied. With no such name the whole message is read, and only a
 * message that names a suscripción and NOT a reembolso counts as one: naming both says
 * nothing about which half this is, and the half that left is what this lane already
 * understood by «participaciones».
 */
function confirmsArrival(figures: OperationReceiptFigures, scanned: string): boolean {
  if (figures.operation !== undefined) return SUBSCRIPTION.test(figures.operation);
  return SUBSCRIPTION.test(scanned) && !REDEMPTION.test(scanned);
}

/**
 * The traspaso the user has written and no card has spent yet (#1798).
 *
 * Only the user's own messages are read: prose written by the ASSISTANT is the model
 * quoting itself, which is #1418's whole doctrine. Within those, the figures last until
 * they are spent, which is the rule decided with Jose after «Sí, procede con la creación
 * y el traspaso» was refused for lacking an importe two messages below the importe:
 *
 * - The walk goes from the most recent message back. A message that states nothing
 *   about a traspaso is transparent, so «vale» or «¿lo ves?» breaks nothing.
 * - The FIRST message that states something decides, read or incomplete. Two messages
 *   are never stitched together — the importe of one and the date of another is a
 *   traspaso nobody wrote — and a half-written one is told what IT lacks.
 * - The walk stops at any assistant answer that carries a traspaso card, confirmed or
 *   not: a card born of a reading spends it, so «hazlo otra vez» cannot write the same
 *   traspaso twice.
 *
 * «Hoy» and «ayer» are still resolved against `today`, the clock of the turn being
 * answered, whichever message they were written in — exactly as before.
 */
export function typedTransferInTurn(
  messages: readonly UIMessage[],
  today: string,
): TypedTransferReading {
  let turnsOwnMessage = true;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.parts.some(drewTransferCard)) break;
    if (message.role !== "user") continue;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join("\n");
    const reading = parseTypedTransfer(text, today);
    if (reading.status === "absent") {
      turnsOwnMessage = false;
      continue;
    }
    if (reading.status === "read" && !turnsOwnMessage) {
      return { ...reading, earlierMessage: text };
    }
    return reading;
  }
  return { status: "absent" };
}

/**
 * Did this part put a traspaso card on the screen? Asked through the same table the
 * render reads (#1468), so a refused call — which paints nothing — spends nothing.
 */
function drewTransferCard(part: UIMessage["parts"][number]): boolean {
  return proposalCardInPart(part)?.kind === "transfer";
}

type PortionReading =
  | { ok: true; portion: TransferPortion }
  /** `statesNothing`: no figure and no «todo» at all — the gap is a silence. */
  | { ok: false; gap: TypedTransferGap; statesNothing?: true };

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
  if (amount === undefined) {
    return stated.units.length === 0
      ? { gap: "amount", ok: false, statesNothing: true }
      : { gap: "amount", ok: false };
  }

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
