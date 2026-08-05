/**
 * The document-only frontier of `propose_reconcile` (#1373).
 *
 * The tool's contract always said it was a document lane — «pasa holdings y
 * movements TAL CUAL los diste por extraídos» — but nothing checked it, so the rows
 * were whatever the model typed. In the session that opened this issue that cost a
 * user three turns of arguing: handed a MyInvestor aportación confirmation for
 * «MYINVESTOR INDEXADO SP 500 PP», the model wrote into the row the name of the
 * OTHER pension plan in the portfolio, and filled the schema's mandatory `value`
 * with a figure the document does not contain (a snapshot of the portfolio). The
 * card had no way to know: to the code it was a clean match.
 *
 * This module turns the contract into a boundary. The rows come from the validated
 * extraction — the model only SELECTS among them, by name or ISIN — so a row that is
 * not in a document worthline read cannot exist, and the values, the fidelity tiers
 * and the movements are the extractor's, never the model's prose.
 *
 * Pure and I/O-free: documents and claims in, a document or a routing error out.
 */

import type {
  ExtractedDocument,
  ExtractedHolding,
  ExtractedPositionsMovementsDocument,
} from "./attachment-extraction-contract";

/**
 * What the model may say about a row: enough to POINT at one of the document's
 * holdings. `value` is accepted (the tool used to demand it) and verified when
 * present, never trusted: a value that disagrees with the document is the exact
 * symptom of a fabricated row.
 */
export interface ReconcileRowClaim {
  name?: string | undefined;
  isin?: string | undefined;
  value?: number | undefined;
}

export type ReconcileDocumentResolution =
  | { ok: true; document: ExtractedPositionsMovementsDocument }
  | { ok: false; error: ReconcileFrontierError };

export interface ReconcileFrontierError {
  error: "reconcile_document_required" | "reconcile_row_not_in_document";
  message: string;
}

/**
 * No validated positions/movements document is on the table. The message ROUTES
 * rather than just refusing (the #1248 rule): the two things a user arriving here
 * actually has are a whole portfolio — which belongs in the deterministic import —
 * and one dated operation on a holding that already exists, which now has its own
 * lane (`propose_operation`, #1374). Naming the lane is what turns a dead end into an
 * answer, and until that lane existed this same sentence had to send people to the
 * holding's ficha.
 */
export const RECONCILE_DOCUMENT_REQUIRED_MESSAGE =
  "El reconcile de cartera solo lo puedo preparar sobre un documento de posiciones o " +
  "movimientos que yo haya leído y validado, y en esta conversación no hay ninguno: no " +
  "puedo escribir filas dictadas por mí. Si lo que traes es una operación puntual " +
  "(una compra, una venta, una aportación) sobre una inversión que ya tienes, ésa se " +
  "anota con su justificante: súbeme el recibo y la preparo como propuesta de " +
  "operación. Si es la cartera entera, súbeme el extracto o el Excel, o usa " +
  "/patrimonio/importar-extracto.";

/**
 * The row named nothing the document contains. Almost always the same mistake as
 * the session that opened #1373 — the holding of the WORKSPACE typed in instead of
 * the text of the document — so the message says which names ARE readable rather
 * than leaving the model to guess again.
 */
export function reconcileRowNotInDocumentMessage(
  unmatched: readonly string[],
  available: readonly string[],
): string {
  return (
    `Estas filas no están en el documento que he validado: ${unmatched.join(", ")}. ` +
    "No puedo llevar al patrimonio una fila que no salga de él (ni con el nombre del " +
    `holding de la cartera: en el documento pone ${available.join(", ")}). Pasa los ` +
    "nombres tal cual los trae el documento, o, si lo que quieres es anotar una " +
    "operación fechada en una inversión que ya existe, prepárala desde su justificante " +
    "en lugar de por aquí."
  );
}

/**
 * The validated union's positions/movements member. `ExtractedDocument` is BRANDED
 * (`ValidatedExtractedDocument`) precisely so an unvalidated literal cannot pass for
 * an extraction, so narrowing keeps the brand; what this module hands on afterwards
 * is the plain document type, which the proposal builder re-validates anyway.
 */
type ValidatedPositionsMovementsDocument = Extract<
  ExtractedDocument,
  { documentType: "positions_movements" }
>;

/** The last positions/movements document the model was given, if any. */
export function positionsMovementsInContext(
  documents: readonly ExtractedDocument[],
): ExtractedPositionsMovementsDocument | null {
  const matching = documents.filter(
    (document): document is ValidatedPositionsMovementsDocument =>
      document.documentType === "positions_movements",
  );
  return matching.length === 0 ? null : matching[matching.length - 1]!;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeIsin(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * How much a relayed value may differ from the document's: one euro. Enough for a
 * whole-euro relay of a figure with cents (5.508,68 € said as «5.509 €»), nowhere
 * near enough for a different holding's value to pass as this one's.
 */
const VALUE_TOLERANCE_EUR = 1;

/** The document holding a claim points at, or `null` when it points at nothing. */
function findClaimedHolding(
  claim: ReconcileRowClaim,
  holdings: readonly ExtractedHolding[],
): ExtractedHolding | null {
  const isin = claim.isin ? normalizeIsin(claim.isin) : null;
  const name = claim.name ? normalizeName(claim.name) : null;
  const byIsin =
    isin === null
      ? undefined
      : holdings.find((holding) => holding.isin && normalizeIsin(holding.isin) === isin);
  const byName =
    name === null
      ? undefined
      : holdings.find((holding) => normalizeName(holding.name) === name);
  // Two identifiers that resolve to two different rows is a contradiction, not a
  // match to arbitrate: the batch would write one of them on the strength of half a
  // claim. ISIN wins only when the name resolves to nothing — the ordinary case of a
  // model relaying a name of its own next to the document's identifier.
  if (byIsin && byName && byIsin !== byName) return null;
  const found = byIsin ?? byName;
  if (!found) return null;
  // And an identifier that resolves to nothing may still CONTRADICT the row it landed
  // on: a name that matches while the ISIN beside it belongs to no row of the document
  // and disagrees with this one's is the same slip as a fabricated value. A document
  // row with no ISIN of its own cannot contradict anything.
  if (isin !== null && found.isin && normalizeIsin(found.isin) !== isin) return null;
  if (
    claim.value !== undefined &&
    Math.abs(claim.value - found.value) > VALUE_TOLERANCE_EUR
  ) {
    return null;
  }
  return found;
}

/** How a claim reads back to the model when it matched nothing. */
function describeClaim(claim: ReconcileRowClaim): string {
  const label = claim.name?.trim() || claim.isin?.trim() || "(sin nombre)";
  return claim.value === undefined ? `«${label}»` : `«${label}» (${claim.value})`;
}

/**
 * Resolve the batch the reconcile will work on. The result is always built from the
 * VALIDATED document: the claims only pick which of its holdings take part, and a
 * claim that picks nothing fails the whole call — a half-understood batch quietly
 * shrunk to the rows that happened to match is how a wrong write looks reasonable.
 *
 * No claims at all means the whole document, which is the honest reading of «cuádrame
 * esto»: the model named no subset, so nothing is being selected out.
 */
export function resolveReconcileDocument(
  claims: readonly ReconcileRowClaim[],
  validated: ExtractedPositionsMovementsDocument | null,
): ReconcileDocumentResolution {
  if (validated === null) {
    return {
      ok: false,
      error: {
        error: "reconcile_document_required",
        message: RECONCILE_DOCUMENT_REQUIRED_MESSAGE,
      },
    };
  }
  if (claims.length === 0) return { ok: true, document: validated };

  const picked: ExtractedHolding[] = [];
  const unmatched: string[] = [];
  for (const claim of claims) {
    const holding = findClaimedHolding(claim, validated.holdings);
    if (!holding) {
      unmatched.push(describeClaim(claim));
      continue;
    }
    if (!picked.includes(holding)) picked.push(holding);
  }
  if (unmatched.length > 0) {
    return {
      ok: false,
      error: {
        error: "reconcile_row_not_in_document",
        message: reconcileRowNotInDocumentMessage(
          unmatched,
          validated.holdings.map((holding) => `«${holding.name}»`),
        ),
      },
    };
  }
  return {
    ok: true,
    document: {
      ...validated,
      // Document order, not the order the model listed them in: the rows are the
      // document's, and `row-N` ids stay stable against the extraction the user saw.
      holdings: validated.holdings.filter((holding) => picked.includes(holding)),
    },
  };
}
