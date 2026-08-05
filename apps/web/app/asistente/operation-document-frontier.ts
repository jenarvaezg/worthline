/**
 * The document-only frontier of `propose_operation` (#1374) — the sibling of
 * `reconcile-document-frontier.ts`, built the same way and for the same reason.
 *
 * The lane exists because «añádeme esta compra» had none. Handed a MyInvestor
 * aportación confirmation, the model reached for `propose_reconcile`, whose schema
 * demands each row's current `value`; it filled that mandatory field with a snapshot
 * of the portfolio and then explained the invented figure to the user as part of the
 * plan. So this tool asks for no such thing — and it also refuses to take the FACT
 * from the model's prose: the date, the amount, the participaciones and the
 * commission come off a document worthline read and validated, and the model's own
 * arguments are only a claim about which document, checked and then discarded.
 *
 * What the model does decide, and no boundary can decide for it: which holding of
 * the user's the paper belongs to (that is the ungrounded-id and the ISIN check in
 * the builder), and whether the paper is a purchase or a sale. The card prints the
 * document's own words next to both, so a wrong reading is visible before confirming.
 *
 * Pure and I/O-free: documents and a claim in, an observed event or a routing error
 * out.
 */

import type {
  ExtractedDocument,
  ExtractedHoldingEvent,
  ExtractedHoldingEventDocument,
} from "./attachment-extraction-contract";

/** What the ledger records. An aportación is a `buy` (ADR 0006: units × price). */
export type OperationKindClaim = "buy" | "sell" | "contribution";

/**
 * What the model may say about the fact: enough to POINT at the event worthline
 * extracted, plus the one judgement the document cannot make (`kind`). Every
 * observed figure is optional and verified when present, never trusted — a figure
 * that disagrees with the document is the exact symptom of an invented fact.
 */
export interface OperationFactClaim {
  kind: OperationKindClaim;
  date?: string | undefined;
  amount?: number | undefined;
  currency?: string | undefined;
  isin?: string | undefined;
  units?: number | undefined;
  pricePerUnit?: number | undefined;
  fees?: number | undefined;
}

export type OperationDocumentResolution =
  | { ok: true; event: ExtractedHoldingEvent }
  | { ok: false; error: OperationFrontierError };

export interface OperationFrontierError {
  error:
    | "operation_document_required"
    | "operation_fact_not_in_document"
    | "operation_kind_contradicts_document";
  message: string;
}

/**
 * No validated dated-fact document is on the table. The message ROUTES rather than
 * just refusing (the #1248 rule): the two things a user arriving here actually has
 * are the confirmation itself — which worthline can read, and must, before it can be
 * written — and a whole portfolio, which belongs in the reconcile or the
 * deterministic import.
 */
export const OPERATION_DOCUMENT_REQUIRED_MESSAGE =
  "Para anotar una operación necesito el justificante leído y validado por mí, y en esta " +
  "conversación no hay ninguno: no puedo escribir en el libro una fecha, un importe y unas " +
  "participaciones dictados por mí. Súbeme la confirmación de la compra, la venta o la " +
  "aportación (PDF o imagen) y la preparo; si lo que traes es la cartera entera, eso es un " +
  "reconcile o /patrimonio/importar-extracto; y si prefieres teclearla, se anota en las " +
  "operaciones de la posición, dentro de Patrimonio.";

/**
 * A figure relayed by the model contradicts the document. The message says WHAT the
 * document actually reads, because the mistake this catches is the one that opened
 * the issue — a figure taken from the portfolio instead of from the paper — and a
 * refusal that does not name the real value invites the same guess again.
 */
export function operationFactNotInDocumentMessage(mismatches: readonly string[]): string {
  return (
    `Esto no es lo que dice el documento que he validado: ${mismatches.join("; ")}. ` +
    "No anoto una operación con cifras que no salgan de él. Pásame los datos tal cual los " +
    "trae el justificante, o, si la operación que quieres registrar es otra, súbeme su " +
    "justificante."
  );
}

/**
 * The validated union's holding-event member. `ExtractedDocument` is BRANDED
 * (`ValidatedExtractedDocument`) precisely so an unvalidated literal cannot pass for
 * an extraction, so narrowing keeps the brand; what this module hands on afterwards
 * is the plain event type.
 */
type ValidatedHoldingEventDocument = Extract<
  ExtractedDocument,
  { documentType: "holding_event" }
>;

/** The last holding-event document the model was given, if any. */
export function holdingEventInContext(
  documents: readonly ExtractedDocument[],
): ExtractedHoldingEventDocument | null {
  const matching = documents.filter(
    (document): document is ValidatedHoldingEventDocument =>
      document.documentType === "holding_event",
  );
  return matching.length === 0 ? null : matching[matching.length - 1]!;
}

/**
 * How much a relayed amount may differ from the document's: one euro. Enough for a
 * whole-euro relay of a figure with cents (125,50 € said as «126 €»), nowhere near
 * enough for another holding's figure to pass as this one's — the same tolerance and
 * the same reasoning as the reconcile's row values.
 */
const AMOUNT_TOLERANCE = 1;

/**
 * How much a relayed quantity of participaciones may differ: the sixth decimal, the
 * last one the app prints. A quantity is not a rounded reading — it is copied — so
 * the slack only absorbs float noise, never a different figure.
 */
const UNITS_TOLERANCE = 0.000001;

/** Cents of slack on a relayed commission: a printed fee is exact to the cent. */
const FEES_TOLERANCE = 0.005;

function isoDay(value: string): string {
  return value.trim();
}

function money(amount: number): string {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(amount);
}

function quantity(amount: number): string {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 6 }).format(amount);
}

/**
 * The event kinds the extraction can pin to a DIRECTION. `deposit` is money going
 * in and `withdrawal` money going out, so a claim that reads one as the other is a
 * contradiction, not a judgement call. Everything else — and `other` is what a
 * securities trade confirmation gets (#1316) — leaves the direction to the model,
 * which is why the card prints the document's `label` verbatim next to it.
 */
const DIRECTION_BY_EVENT_KIND: Partial<
  Record<ExtractedHoldingEvent["kind"], "in" | "out">
> = { deposit: "in", withdrawal: "out" };

/** Every way a claim can disagree with the event, as sentences for the model. */
function claimMismatches(
  claim: OperationFactClaim,
  event: ExtractedHoldingEvent,
): string[] {
  const mismatches: string[] = [];
  if (claim.date !== undefined && isoDay(claim.date) !== event.date) {
    mismatches.push(`la fecha del documento es ${event.date}, no ${isoDay(claim.date)}`);
  }
  if (
    claim.amount !== undefined &&
    Math.abs(Math.abs(claim.amount) - Math.abs(event.amount)) > AMOUNT_TOLERANCE
  ) {
    mismatches.push(
      `el importe del documento es ${money(event.amount)}, no ${money(claim.amount)}`,
    );
  }
  if (
    claim.currency !== undefined &&
    claim.currency.trim().toUpperCase() !== event.currency.toUpperCase()
  ) {
    mismatches.push(`la divisa del documento es ${event.currency}`);
  }
  if (claim.isin !== undefined) {
    const claimed = claim.isin.trim().toUpperCase();
    if (event.isin === undefined) {
      mismatches.push(`el documento no trae ningún ISIN, y tú pasas ${claimed}`);
    } else if (event.isin.toUpperCase() !== claimed) {
      mismatches.push(`el ISIN del documento es ${event.isin}, no ${claimed}`);
    }
  }
  if (claim.units !== undefined) {
    if (event.units === undefined) {
      // The invention this lane most has to fear: a quantity nobody printed becomes
      // units in the ledger forever, and every later sale inherits the error (#1315).
      mismatches.push(
        `el documento no dice las participaciones, y tú pasas ${quantity(claim.units)}`,
      );
    } else if (Math.abs(claim.units - event.units) > UNITS_TOLERANCE) {
      mismatches.push(
        `las participaciones del documento son ${quantity(event.units)}, no ${quantity(claim.units)}`,
      );
    }
  }
  // The PRINTED price is not compared when the document has one: what gets written is
  // `(importe − comisión) / participaciones`, so the model may legitimately relay
  // either figure and neither is the single authority. A price relayed for a document
  // that prints none is invention with nothing behind it.
  if (claim.pricePerUnit !== undefined && event.pricePerUnit === undefined) {
    mismatches.push(
      `el documento no imprime precio por título, y tú pasas ${money(claim.pricePerUnit)}`,
    );
  }
  if (claim.fees !== undefined) {
    const printed = event.fees?.amount ?? 0;
    if (Math.abs(claim.fees - printed) > FEES_TOLERANCE) {
      mismatches.push(
        event.fees === undefined
          ? `el documento no imprime comisión, y tú pasas ${money(claim.fees)}`
          : `la comisión del documento es ${money(event.fees.amount)}, no ${money(claim.fees)}`,
      );
    }
  }
  return mismatches;
}

/**
 * Resolve the fact the operation will be built from. The result is always the
 * VALIDATED event: the claim only says which document it is and which direction it
 * runs, and a claim that disagrees fails the whole call — a figure quietly replaced
 * by the document's is how a wrong write looks reasonable, and a figure quietly kept
 * is the invention this lane exists to stop.
 */
export function resolveOperationEvent(
  claim: OperationFactClaim,
  validated: ExtractedHoldingEventDocument | null,
): OperationDocumentResolution {
  if (validated === null) {
    return {
      ok: false,
      error: {
        error: "operation_document_required",
        message: OPERATION_DOCUMENT_REQUIRED_MESSAGE,
      },
    };
  }
  const { event } = validated;
  const mismatches = claimMismatches(claim, event);
  if (mismatches.length > 0) {
    return {
      ok: false,
      error: {
        error: "operation_fact_not_in_document",
        message: operationFactNotInDocumentMessage(mismatches),
      },
    };
  }
  const direction = DIRECTION_BY_EVENT_KIND[event.kind];
  const claimed = claim.kind === "sell" ? "out" : "in";
  if (direction !== undefined && direction !== claimed) {
    return {
      ok: false,
      error: {
        error: "operation_kind_contradicts_document",
        message:
          `El documento registra el apunte como ${direction === "in" ? "un ingreso" : "una retirada"} ` +
          `(«${event.label}»), así que no puedo anotarlo como ${claim.kind === "sell" ? "una venta" : "una compra"}. ` +
          "Comprueba qué justificante estás leyendo.",
      },
    };
  }
  return { ok: true, event };
}
