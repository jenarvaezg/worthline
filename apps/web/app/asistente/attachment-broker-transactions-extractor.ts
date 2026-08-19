import { readSpreadsheetGrids, type SpreadsheetGridInput } from "@web/spreadsheet-grid";
import {
  type BrokerTransactionRow,
  type BrokerTransactionTable,
  readBrokerTransactionTable,
} from "@worthline/domain";

import {
  type AttachmentExtractionResult,
  capExtractionWarnings,
  checkAttachmentLimits,
  type ExtractedTransaction,
  extractedTransactionSchema,
  parseExtractionResult,
} from "./attachment-extraction-contract";

/**
 * Deterministic extractor for the **broker transactions** document from a spreadsheet
 * (#1487) — the fourth arm of the sheet dispatch.
 *
 * It owns almost nothing: the reading is the domain's shared
 * {@link readBrokerTransactionTable}, because the web statement gate reads the same
 * tables through the same aliases and the same sign rule (#1488), and two readers would
 * be two answers about somebody's money. What lives here is the lane's own half — the
 * attachment limits, the mapping into the branded contract, and the fallback to
 * `unrecognized` so a sheet that is not a ledger still reaches #865's unstructured lane.
 *
 * Security (the #865 invariant): no model runs on this route, so the untrusted workbook
 * never reaches one. The only free text that survives is the instrument name, which the
 * contract length-caps, and the warnings this app generated itself.
 */

export type BrokerTransactionsExtractionInput = SpreadsheetGridInput & {
  mimeType: string;
};

const UNRECOGNIZED_MESSAGE =
  "No reconozco un extracto de transacciones en esta hoja. Revisa que tenga una columna de " +
  "fecha, el ISIN o el nombre del producto, los títulos y el precio o el importe de cada operación.";

/** The contract row for one reading, or null when the contract refuses it. */
function toTransaction(row: BrokerTransactionRow): ExtractedTransaction | null {
  const parsed = extractedTransactionSchema.safeParse({
    amount: row.amount,
    currency: row.currency,
    date: row.date,
    kind: row.kind,
    pricePerUnit: row.pricePerUnit,
    units: row.units,
    ...(row.isin ? { isin: row.isin } : {}),
    ...(row.name ? { name: row.name } : {}),
    ...(row.feesMinor > 0 ? { feesMinor: row.feesMinor } : {}),
    ...(row.orderId ? { orderId: row.orderId } : {}),
    ...(row.uncertain ? { uncertain: true } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/** The first worksheet that reads as a ledger. A workbook rarely holds two. */
function firstTransactionTable(
  sheets: readonly { name: string; rows: string[][] }[],
): BrokerTransactionTable | null {
  for (const sheet of sheets) {
    const table = readBrokerTransactionTable(sheet.rows);
    if (table) return table;
  }
  return null;
}

function unsupportedDocument(message: string): AttachmentExtractionResult {
  return {
    code: "unsupported_document",
    failure: "permanent",
    message,
    status: "failure",
  };
}

/**
 * Deterministically map a broker transactions export into the shared contract. Returns
 * `unrecognized` when no worksheet carries a ledger, so the caller can fall through to
 * the dated balance series and then to unstructured context (#865).
 *
 * A row the reader could not read is a warning, never a dead end: a real export carries
 * dividends, currency conversions and deposits beside its trades, and none of those is
 * an operation on an instrument. The document travels with the trades it could read and
 * says out loud what it skipped.
 */
export function extractBrokerTransactionsFromSpreadsheet(
  input: BrokerTransactionsExtractionInput,
): AttachmentExtractionResult {
  const initialLimit = checkAttachmentLimits({
    fileName: input.fileName,
    kind: "spreadsheet",
    mimeType: input.mimeType,
    rowCount: 0,
    sizeBytes: input.bytes.byteLength,
  });
  if (initialLimit) return initialLimit;

  const grids = readSpreadsheetGrids({ bytes: input.bytes, fileName: input.fileName });
  if (grids.status === "unreadable") {
    return unsupportedDocument("La hoja no se puede leer.");
  }

  const table = firstTransactionTable(grids.sheets);
  if (!table) return { message: UNRECOGNIZED_MESSAGE, status: "unrecognized" };

  // The bound is the number of TRADES read, not the height of the sheet: an export whose
  // trades sit under hundreds of cash movements would otherwise be refused for rows this
  // document never claims to carry (#1417's own measurement, one document over).
  const rowLimit = checkAttachmentLimits({
    fileName: input.fileName,
    kind: "spreadsheet",
    mimeType: input.mimeType,
    rowCount: table.rows.length,
    sizeBytes: input.bytes.byteLength,
  });
  if (rowLimit) return rowLimit;

  const transactions: ExtractedTransaction[] = [];
  const warnings = [...table.warnings];
  for (const row of table.rows) {
    const transaction = toTransaction(row);
    if (transaction) {
      transactions.push(transaction);
      continue;
    }
    warnings.push(
      `Fila ${row.line} de la tabla: la operación leída no es válida; se ha omitido.`,
    );
  }

  // A ledger every row of which the contract refused is not a ledger after all; fall
  // back rather than dead-ending on a card with nothing on it.
  if (transactions.length === 0) {
    return { message: UNRECOGNIZED_MESSAGE, status: "unrecognized" };
  }

  const uncertain =
    table.directionSource === "assumed_buy" ||
    table.assumedCurrency ||
    transactions.some((transaction) => transaction.uncertain);

  return parseExtractionResult({
    data: {
      documentType: "broker_transactions",
      transactions,
      warnings: capExtractionWarnings(warnings),
      ...(uncertain ? { uncertain: true } : {}),
    },
    status: "valid",
  });
}
