/**
 * The es-ES copy of a traspaso proposal (#1482) — the words the card prints, kept out
 * of the component so they can be asserted without rendering React, exactly as the
 * operation lane's are (`operation-proposal-copy.ts`).
 *
 * What each line is FOR, because a traspaso's card has to answer three questions the
 * other cards do not:
 *
 * - **What did worthline read in my message?** The importe and the date are parsed off
 *   the user's own text (`typed-transfer.ts`), so the card echoes them verbatim: that
 *   echo is the whole ceremony of this lane — if the parser read 1.018,67 € where the
 *   person wrote 1.018,76 €, this is the line where it is caught.
 * - **How many participaciones move, and at what VL?** One of the two is always
 *   derived: the participaciones from the importe at the app's own price, or — when the
 *   message stated them (#1544) — the VL from the importe over those participaciones.
 *   Printing both means the derivation is checkable against the bank's paper.
 * - **What does it do to my book?** Nothing, and that is the point of the instrument:
 *   no plusvalía, no cupo de aportación spent. Said in words on the card because a
 *   delta of «0 €» alone reads as «nothing happened».
 *
 * Pure and I/O-free (`docs/interaction-patterns.md`, ADR 0036).
 */

import { formatPrice, formatUnits, type TransferPortion } from "@worthline/domain";

import { currencyMark, formatDocumentMoney } from "./document-figures";
import { formatIsoDayEs } from "./iso-day-es";

/** The atomic folio: one proposal, one movement, the two rows it ties. */
export const TRANSFER_FOLIO = "1 propuesta · 1 traspaso · 2 apuntes atados";

/**
 * The caption under the impact header. «Estimado» for the same reason as the
 * operation's: the ripple values both positions at their own prices afterwards, so the
 * change is around zero rather than exactly it — the two halves are valued at two VLs.
 */
export const TRANSFER_IMPACT_CAPTION = "estimado sobre el traspaso";

/**
 * What a traspaso does NOT do. Printed on the card, not left to the prose: these are
 * the two invariants of the instrument (PRD #1393, ADR 0082) and the two things a user
 * who has just seen «venta» in another app expects to happen.
 */
export const TRANSFER_NEUTRALITY_NOTE =
  "Un traspaso no realiza plusvalía ni consume cupo de aportación: el coste de " +
  "adquisición viaja con las participaciones.";

/**
 * The fact as WORTHLINE READ IT in the message — the date and the portion, and nothing
 * derived. «Todo» prints as itself, never as the importe it happens to equal: they are
 * two different writes, and only «todo» empties the origin exactly.
 */
export function transferDictatedLine(dictated: {
  executedAt: string;
  portion: TransferPortion;
  currency: string;
}): string {
  const money = (amountMinor: number) =>
    formatDocumentMoney(amountMinor, dictated.currency);
  const portion =
    dictated.portion.kind === "all"
      ? "todo el saldo"
      : dictated.portion.kind === "units"
        ? // Both figures, because both were WRITTEN (#1544) — and this echo is the one
          // place where a misread participación can still be caught.
          `${formatUnits(dictated.portion.units)} participaciones · ${money(dictated.portion.amountMinor)}`
        : money(dictated.portion.amountMinor);
  return `${formatIsoDayEs(dictated.executedAt)} · ${portion}`;
}

/**
 * One half of the pair, term by term as it will be written:
 * `37,203 part. × 19,87091 € · 739,22 €`.
 *
 * The VL goes through `formatPrice` and not the document voice: a plan de pensiones
 * quotes five decimals (19,87091), and rounding it to four would print a figure that
 * does not match the bank's statement the user is holding — which is the one thing
 * this card exists to make checkable.
 */
export function transferHalfLine(half: {
  units: string;
  pricePerUnit: string;
  amountMinor: number;
  currency: string;
}): string {
  return (
    `${formatUnits(half.units)} part. × ${formatPrice(half.pricePerUnit)} ${currencyMark(half.currency)}` +
    ` · ${formatDocumentMoney(half.amountMinor, half.currency)}`
  );
}

/** A side of the traspaso: whose ledger moves, and its participaciones before → after. */
export function transferSideLine(side: {
  direction: "out" | "in";
  name: string;
  unitsBefore: string;
  unitsAfter: string;
}): string {
  const verb = side.direction === "out" ? "Salen de" : "Entran en";
  return `${verb} «${side.name}»: ${formatUnits(side.unitsBefore)} → ${formatUnits(side.unitsAfter)} participaciones`;
}

/** The acquisition cost travelling with the units, as the card names it. */
export function transferInheritedCostLine(
  inheritedCostMinor: number,
  currency: string,
): string {
  return `Coste de adquisición que viaja: ${formatDocumentMoney(inheritedCostMinor, currency)}`;
}

/**
 * The honest note about WHERE a VL came from, when it is not the transfer date's own.
 *
 * The chat lane does not ask for the two VLs — nobody dictates them — so it uses the
 * app's own price for each holding. That is the same figure the screen of #1480
 * prefills, and it is right for the ordinary «he traspasado hoy» case; for a backdated
 * traspaso it is the price of another day, which changes the participaciones. Saying so
 * is the difference between a derivation the user can check and one they have to trust,
 * and the way out is named: the screen, where the VL is a field.
 */
export function transferPriceProvenanceNote(price: {
  side: "origin" | "destination";
  name: string;
  pricePerUnit: string;
  /** The day the price is from, when the app knows it. */
  priceDate?: string;
  executedAt: string;
  manual: boolean;
}): string | null {
  if (!price.manual && price.priceDate === price.executedAt) return null;
  const origin = price.manual
    ? "es el valor que tienes puesto a mano"
    : price.priceDate === undefined
      ? "es el último que tengo, sin fecha"
      : `es del ${formatIsoDayEs(price.priceDate)}`;
  const side = price.side === "origin" ? "origen" : "destino";
  return (
    `El VL de ${side} que he usado para «${price.name}» (${formatPrice(price.pricePerUnit)}) ` +
    `${origin}, no el del ${formatIsoDayEs(price.executedAt)}: si el banco te da otro, ` +
    "regístralo desde «Traspasar» en la ficha de la posición, donde el VL es un campo."
  );
}
