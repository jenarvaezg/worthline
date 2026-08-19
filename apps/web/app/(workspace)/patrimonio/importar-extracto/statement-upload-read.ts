import { readSpreadsheetGrids } from "@web/spreadsheet-grid";
import {
  isSpreadsheet,
  SpreadsheetReadError,
  spreadsheetToAllSheets,
  spreadsheetToDelimitedText,
  type WorkbookSheet,
} from "@web/spreadsheet-text";
import type { ParsedStatement, StatementBroker } from "@worthline/domain";
import {
  ASSUMED_BUY_WARNING,
  readBrokerTransactionTable,
  statementFromBrokerTransactions,
  statementHeaderMatches,
} from "@worthline/domain";

import { readStatementFromText } from "./statement-import-preview";

/**
 * What the statement gate can READ, and the one place that answers it (#1488).
 *
 * Until this module the gate spoke a single format. `STATEMENT_BROKER_ADAPTERS` had
 * exactly one entry — `plantilla` — so the most standard file in retail investing, a
 * broker's `Transactions.xlsx`, was refused here; and the assistant, which had just
 * pointed a user at this door as the «correct» route for his DEGIRO export, was
 * promising something the door could not do. Both halves are the same bug: nobody had
 * written down what this gate speaks, so neither the code nor the model could tell.
 *
 * The second format is the domain's shared broker-transactions reader (#1487), NOT a
 * DEGIRO adapter: it is steered by the destination contract (a date, an instrument, units,
 * a price or an amount, a currency, costs, a direction from a column or from the sign),
 * so a new broker is aliases plus a fixture and never a branch here.
 *
 * Order matters and is the subtle part. The plantilla goes FIRST and wins on its header
 * alone, because «the plantilla refused this file» covers two very different things: a
 * file that is not a plantilla, and a plantilla with one malformed row — whose
 * all-or-nothing error is the most useful sentence anybody can be handed (ADR 0010).
 * Only the first falls through. The generic reader would happily resolve the plantilla's
 * own header (Fecha · Participaciones · Importe · Nombre) and answer a question nobody
 * asked.
 *
 * Pure: bytes in, a statement or a Spanish message out. No FX, no IO — the euro
 * conversion stays at the action, on the rows (#1401, #1438).
 */

/**
 * The formats this gate reads, in the words a person is told them in. The single source
 * for the page's own copy AND for the assistant's context: the model may only name this
 * door as an exit for a file it actually reads, and it cannot know that unless it is
 * told (#1488 — the «falsa esperanza» half).
 */
export const STATEMENT_GATE_FORMATS = [
  "la plantilla de worthline",
  "el extracto de transacciones de un bróker (con ISIN)",
] as const;

const UNRECOGNIZED_MESSAGE =
  `No reconozco este archivo. Aquí se puede subir ${STATEMENT_GATE_FORMATS.join(" o ")}: ` +
  "para el extracto del bróker hace falta una columna de fecha, el ISIN o el nombre del " +
  "producto, los títulos y el precio o el importe de cada operación.";

export type StatementUploadRead =
  | { ok: false; message: string }
  | {
      ok: true;
      statement: ParsedStatement;
      /**
       * What the reading could not settle — a direction taken from nothing, an assumed
       * currency, a row skipped. Empty for a plantilla, which states everything.
       */
      warnings: string[];
    };

export interface StatementUploadInput {
  bytes: Uint8Array;
  /** The uploaded name, used to tell a CSV from a workbook when the bytes cannot. */
  fileName: string;
  broker: StatementBroker;
}

/**
 * Every worksheet of the upload as raw cells, or null when it cannot be read at all.
 *
 * The workbook branch keys off the BYTES rather than the extension, the same signal the
 * delimited-text path has always used: a .xlsx saved as «Transactions.csv» is a file
 * people really upload, and one answer to «is this an Excel» is better than two.
 */
function sheetsOf(input: StatementUploadInput): WorkbookSheet[] | null {
  if (isSpreadsheet(input.bytes)) {
    try {
      return spreadsheetToAllSheets(input.bytes);
    } catch (error) {
      if (error instanceof SpreadsheetReadError) return null;
      throw error;
    }
  }
  const grids = readSpreadsheetGrids({ bytes: input.bytes, fileName: input.fileName });
  return grids.status === "ok" ? grids.sheets : null;
}

/** The upload's first sheet as the `;`-delimited text every adapter reads. */
function delimitedText(
  bytes: Uint8Array,
): { ok: true; text: string } | { ok: false; message: string } {
  if (!isSpreadsheet(bytes)) {
    return { ok: true, text: new TextDecoder().decode(bytes) };
  }
  try {
    return { ok: true, text: spreadsheetToDelimitedText(bytes) };
  } catch (error) {
    if (error instanceof SpreadsheetReadError)
      return { message: error.message, ok: false };
    throw error;
  }
}

/**
 * The first worksheet that reads as a ledger, mapped onto the statement contract. A
 * workbook rarely holds two, and the refusals (a trade with no ISIN, a currency the
 * ledger cannot capture) belong to the mapping, not here.
 */
function readTransactions(sheets: readonly WorkbookSheet[]): StatementUploadRead | null {
  for (const sheet of sheets) {
    const table = readBrokerTransactionTable(sheet.rows);
    if (!table) continue;
    const mapped = statementFromBrokerTransactions(table);
    return mapped.ok
      ? {
          ok: true,
          statement: mapped.statement,
          warnings: withDirectionDoubt(mapped.statement, mapped.warnings),
        }
      : { message: mapped.message, ok: false };
  }
  return null;
}

/**
 * A statement whose direction is UNRESOLVED always says so, whichever reader produced it.
 *
 * `directionResolved: false` has existed since ADR 0018's amendment and had no reader on
 * any web surface — the field travelled, nothing printed it, and the ADR said otherwise.
 * It went unnoticed because the plantilla always resolves direction; the generic reader
 * (#1488) is the first one here that can honestly answer «no». So the guarantee lives at
 * the gate rather than in one reader: a format added later cannot forget it.
 *
 * Compared against the domain's own constant, so the sentence a reader ALREADY emitted is
 * never printed twice.
 */
function withDirectionDoubt(
  statement: ParsedStatement,
  warnings: readonly string[],
): string[] {
  if (statement.directionResolved || warnings.includes(ASSUMED_BUY_WARNING)) {
    return [...warnings];
  }
  return [...warnings, ASSUMED_BUY_WARNING];
}

/**
 * Read an uploaded statement: the declared format first, the generic broker-transactions
 * reader when the file is not that format at all.
 */
export function readStatementUpload(input: StatementUploadInput): StatementUploadRead {
  const text = delimitedText(input.bytes);
  if (!text.ok) return { message: text.message, ok: false };

  if (text.text.trim() === "") {
    return { message: "El archivo está vacío.", ok: false };
  }

  if (statementHeaderMatches(text.text, input.broker)) {
    const parsed = readStatementFromText(text.text, input.broker);
    return parsed.ok
      ? {
          ok: true,
          statement: parsed.value,
          warnings: withDirectionDoubt(parsed.value, []),
        }
      : { message: parsed.message, ok: false };
  }

  const sheets = sheetsOf(input);
  if (sheets === null) {
    return {
      message: "El archivo Excel no se puede leer — guarda la hoja como .xlsx.",
      ok: false,
    };
  }

  return readTransactions(sheets) ?? { message: UNRECOGNIZED_MESSAGE, ok: false };
}
