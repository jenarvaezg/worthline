import { STATEMENT_GATE_FORMATS } from "@web/patrimonio/importar-extracto/statement-upload-read";
import type { ParsedStatement, ParsedStatementRow } from "@worthline/domain";
import { CAPTURE_CURRENCIES, isCaptureCurrency } from "@worthline/domain";

import type {
  ExtractedBrokerTransactionsDocument,
  ExtractedDocument,
  ExtractedTransaction,
} from "./attachment-extraction-contract";

/**
 * The document-only frontier of `propose_statement_import` for a broker's transactions
 * export (#1487) — the sibling of `reconcile-document-frontier` (#1373) and of
 * `resolveOperationEvent` (#1374), and it exists for the same reason.
 *
 * The tool has always taken `rawText`: the model retypes the file and the app parses
 * what it typed. For a plantilla somebody pasted that is the only route there is, but for
 * an export worthline has just READ it is the worst one available — the pool does not
 * reproduce digits reliably (#1423: asked for a number it pads zeros to the token
 * ceiling), so relaying eleven trades through it is eleven chances to invent a figure
 * nobody printed. Here the rows come from the deterministic reading and the model only
 * points at it.
 *
 * Pure and I/O-free: a validated document in, a `ParsedStatement` or a routing refusal
 * out.
 */

export type StatementFromDocumentResult =
  | { ok: true; statement: ParsedStatement }
  | { ok: false; error: StatementFromDocumentError; message: string };

export type StatementFromDocumentError =
  | "statement_document_required"
  | "statement_rows_without_isin"
  | "statement_currency_unsupported";

/**
 * No validated transactions document is on the table. The message ROUTES rather than
 * only refusing (the #1248 rule): what a person arriving here has is either the file
 * itself — which this lane reads, if they attach it — or the plantilla of the web gate.
 *
 * This is the EMPTY-context copy. When a positions/movements document IS already on
 * the table, {@link statementDocumentRequiredMessage} names the reconcile lane
 * instead of asking for another upload (#1513).
 */
export const STATEMENT_DOCUMENT_REQUIRED_MESSAGE =
  "Solo puedo preparar la importación de un extracto a partir de un documento de " +
  "transacciones que yo haya leído y validado, o del texto de una plantilla de worthline: " +
  "no puedo escribir operaciones dictadas por mí. Súbeme el archivo del bróker tal cual " +
  "te lo da (xlsx, csv o pdf) y lo leo, o súbelo en /patrimonio/importar-extracto, donde " +
  `entran ${STATEMENT_GATE_FORMATS.join(" o ")}.`;

/**
 * The document on the table is positions/movements, not a transactions extract. The
 * refusal still stands — this lane cannot invent a ledger — but the next step is the
 * chat reconcile of THAT document, not another upload (#1513).
 */
const STATEMENT_DOCUMENT_REQUIRED_WITH_POSITIONS_MESSAGE =
  "Solo puedo preparar la importación de un extracto a partir de un documento de " +
  "transacciones, y lo que hay en esta conversación es un documento de posiciones o " +
  "movimientos ya leído y validado: no hace falta volver a subirlo. Eso se fusiona " +
  "con la cartera desde el chat ahora mismo con propose_reconcile.";

export interface StatementDocumentContext {
  hasPositionsMovements?: boolean;
}

/**
 * Pick the statement-required copy from what IS on the table. An empty context keeps
 * the original routing to the web gate; a positions document names the chat reconcile
 * and never asks to re-upload (#1513).
 */
export function statementDocumentRequiredMessage(
  context: StatementDocumentContext = {},
): string {
  if (context.hasPositionsMovements) {
    return STATEMENT_DOCUMENT_REQUIRED_WITH_POSITIONS_MESSAGE;
  }
  return STATEMENT_DOCUMENT_REQUIRED_MESSAGE;
}

/** The validated union's transactions member — narrowing keeps the brand (#1373). */
type ValidatedBrokerTransactionsDocument = Extract<
  ExtractedDocument,
  { documentType: "broker_transactions" }
>;

/** The last broker transactions document the model was given, if any. */
export function brokerTransactionsInContext(
  documents: readonly ExtractedDocument[],
): ExtractedBrokerTransactionsDocument | null {
  const matching = documents.filter(
    (document): document is ValidatedBrokerTransactionsDocument =>
      document.documentType === "broker_transactions",
  );
  return matching.length === 0 ? null : matching[matching.length - 1]!;
}

/** How a transaction reads back to the model inside a refusal. */
function describeTransaction(transaction: ExtractedTransaction): string {
  return `${transaction.date} ${transaction.name ?? transaction.isin ?? "(sin nombre)"}`;
}

/**
 * Map a validated transactions document onto the statement contract the import gate
 * already consumes (PRD #173, ADR 0055).
 *
 * Two refusals, both all-or-nothing on purpose (ADR 0010 — a statement import writes
 * every row or none):
 *
 * - **a row with no ISIN**. The import routes by ISIN and the planner DROPS a row that
 *   has none, so letting the call through would import nine trades out of eleven and say
 *   nothing. Naming the rows is what makes it a route instead of a wall.
 * - **a currency the app cannot capture**. Operations are stored in a closed currency
 *   vocabulary (#1401); coercing anything else to euros is the exact bug that vocabulary
 *   exists to prevent.
 */
export function statementFromTransactionsDocument(
  document: ExtractedBrokerTransactionsDocument,
): StatementFromDocumentResult {
  const withoutIsin = document.transactions.filter(
    (transaction) => transaction.isin === undefined,
  );
  if (withoutIsin.length > 0) {
    return {
      error: "statement_rows_without_isin",
      message:
        `Estas operaciones del documento no traen ISIN, y la importación de extracto rutea ` +
        `por ISIN: ${withoutIsin.map(describeTransaction).join(", ")}. Si las importara, esas filas se ` +
        "perderían sin avisar. Súbeme el extracto con la columna ISIN, o anótalas una a una " +
        "desde su justificante.",
      ok: false,
    };
  }

  // One pass, so the row is built from the currency the guard NARROWED rather than from a
  // cast asserting what a check three lines up already knew.
  const rows: ParsedStatementRow[] = [];
  const unsupported: string[] = [];
  for (const transaction of document.transactions) {
    if (!isCaptureCurrency(transaction.currency)) {
      unsupported.push(transaction.currency);
      continue;
    }
    rows.push({
      currency: transaction.currency,
      dateKey: transaction.date,
      feesMinor: transaction.feesMinor ?? 0,
      isin: transaction.isin ?? null,
      kind: transaction.kind,
      pricePerUnit: transaction.pricePerUnit,
      units: transaction.units,
      ...(transaction.name === undefined ? {} : { name: transaction.name }),
    });
  }
  if (unsupported.length > 0) {
    return {
      error: "statement_currency_unsupported",
      message:
        `El documento trae operaciones en ${[...new Set(unsupported)].join(", ")} y solo puedo ` +
        `registrar ${CAPTURE_CURRENCIES.join(", ")}. No las convierto yo: eso sería inventarme un ` +
        "tipo de cambio que el documento no dice.",
      ok: false,
    };
  }

  const isins = [
    ...new Set(
      rows.map((row) => row.isin).filter((isin): isin is string => isin !== null),
    ),
  ];

  return {
    ok: true,
    statement: {
      // A doubt anywhere in the reading — a direction taken from nothing but «every row
      // is a buy», a currency assumed — makes the whole statement unresolved, which is
      // what the gate's own pre-confirm warning is for. Erring the other way would hide
      // the one thing the user is the only one able to settle.
      directionResolved: document.uncertain !== true,
      isin: isins.length === 1 ? isins[0]! : null,
      isins,
      rows,
      skipped: [],
    },
  };
}
