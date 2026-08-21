/**
 * The es-ES copy of an operation proposal (#1374) — the words the card prints,
 * extracted from the component so they can be asserted without rendering React, the
 * same way the reconcile row's copy is (#1373).
 *
 * The four lines exist because of four separate ways the improvised path lied: it
 * showed a figure the document does not contain, it summarized the fact instead of
 * printing it, it made the destination holding indistinguishable from the document's
 * own text, and it described an effect on the position that the apply does not have.
 * Each of those is a sentence, and a sentence that matters is worth a test.
 *
 * Pure and I/O-free (`docs/interaction-patterns.md`, ADR 0036).
 */

import {
  currencyMark,
  formatDocumentMoney,
  formatDocumentUnitPrice,
  formatDocumentUnits,
} from "./document-figures";
import { formatIsoDayEs } from "./iso-day-es";
import type { OperationKindClaim } from "./operation-document-frontier";

/**
 * How the operation's kind reads on the card — the DOCUMENT's word, not the ledger's.
 * The apply writes a `contribution` as a buy (an aportación to a plan de pensiones is
 * a purchase of participaciones), and the line could say «compra» for both; it says
 * «aportación» because this line exists to be compared against the paper in the
 * user's hand, and the paper says «APORTACION P.P.». What is written is the same
 * either way — the participaciones, the price and the importe below say so.
 */
const OPERATION_KIND_LABELS: Record<OperationKindClaim, string> = {
  buy: "compra",
  contribution: "aportación",
  sell: "venta",
};

export function operationKindLabel(kind: OperationKindClaim): string {
  return OPERATION_KIND_LABELS[kind];
}

/**
 * The resolved terms this line reads, plus the direction. Structural on purpose: the
 * caller hands over its whole {@link OperationTerms} with the kind alongside, rather
 * than re-spreading seven fields into a fresh literal at the call site — the fields
 * travel together everywhere in this lane, and copying them by hand is how one of them
 * eventually gets left behind.
 */
export interface OperationFactLine {
  executedAt: string;
  kind: OperationKindClaim;
  units: string;
  pricePerUnit: string;
  amountMinor: number;
  currency: string;
  /** Present when the document PRINTED a commission — a printed 0 included. */
  feesMinor?: number;
}

/**
 * The fact, in one line, exactly as it will be written:
 * `05/08/2026 · compra · 5,92 part. × 21,1149 € · comisión 0 € · 125 €`.
 *
 * The commission segment appears only when the document printed one — a printed zero
 * says «sin comisión» and is worth showing, an absent one would paint a `0 €` the
 * paper never stated (the preview card's «only observed fields get a row» rule).
 */
export function operationFactLine(fact: OperationFactLine): string {
  const parts = [
    formatIsoDayEs(fact.executedAt),
    operationKindLabel(fact.kind),
    `${formatDocumentUnits(fact.units)} part. × ${formatDocumentUnitPrice(fact.pricePerUnit)} ${currencyMark(fact.currency)}`,
  ];
  if (fact.feesMinor !== undefined) {
    parts.push(`comisión ${formatDocumentMoney(fact.feesMinor, fact.currency)}`);
  }
  parts.push(formatDocumentMoney(fact.amountMinor, fact.currency));
  return parts.join(" · ");
}

/**
 * What the DOCUMENT says, on its own line: its literal text and, when it prints one,
 * the ISIN. Printed above the destination and never merged with it (#1373's lesson):
 * the two used to be one sentence, so a model that pointed at the wrong plan de
 * pensiones produced a card that agreed with itself and with nothing else.
 */
export function operationDocumentLine(document: {
  label: string;
  isin?: string;
}): string {
  return document.isin === undefined
    ? document.label
    : `${document.label} · ${document.isin}`;
}

/** Where it lands: the holding's own name, and its ISIN when it has one registered. */
export function operationDestinationLine(holding: {
  name: string;
  isin?: string;
}): string {
  const identity = holding.isin === undefined ? "" : ` · ${holding.isin}`;
  return `Anotar en «${holding.name}»${identity}`;
}

/**
 * The caption under the impact header. It says «estimado» always, and on purpose:
 * the apply adds the participaciones, and the ripple then values the whole position
 * at TODAY's price — so the change in net worth is around the document's amount, not
 * exactly it. The improvised path said the opposite («recalibra la valoración»), and
 * that recalibration does not exist.
 */
export const OPERATION_IMPACT_CAPTION = "estimado sobre la operación";

/** The atomic folio, sibling of the early repayment's. */
export const OPERATION_FOLIO = "1 propuesta · 1 posición · 1 operación fechada";
