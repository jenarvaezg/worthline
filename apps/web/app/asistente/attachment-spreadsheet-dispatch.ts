import { extractBalanceSeriesFromSpreadsheet } from "./attachment-balance-series-extractor";
import { extractBrokerTransactionsFromSpreadsheet } from "./attachment-broker-transactions-extractor";
import type { AttachmentExtractionResult } from "./attachment-extraction-contract";
import {
  extractPositionsAndMovementsFromSpreadsheet,
  type PositionsMovementsExtractionInput,
} from "./attachment-positions-movements-extractor";
import { extractPositionsFromSpreadsheet } from "./attachment-spreadsheet-extractor";

/**
 * Choose the spreadsheet document a workbook is (PRD #1103 S4). The richer
 * positions + movements recognizer runs first; a broker positions table it does
 * not recognize falls through to the existing positions extractor, then to a broker's
 * transactions ledger (#1487), then to the dated balance series of a statement or
 * amortization schedule (#1417), and a sheet none of them recognizes still becomes
 * unstructured context (#865). A definitive failure from an earlier recognizer is
 * returned as-is — an unreadable workbook is a failure either way, and retrying it as
 * another document would only repeat the error.
 *
 * The order is by how SPECIFIC each header is. The two portfolio documents come first;
 * the transactions ledger asks for four families (a date, an instrument key, units, and
 * a price or an amount) and so precedes the balance series, which asks only for a date
 * and a balance and which a ledger with a `Saldo` column would also satisfy.
 */
export function extractSpreadsheetDocument(
  input: PositionsMovementsExtractionInput,
): AttachmentExtractionResult {
  const reconcile = extractPositionsAndMovementsFromSpreadsheet(input);
  if (reconcile.status !== "unrecognized") return reconcile;
  const positions = extractPositionsFromSpreadsheet(input);
  if (positions.status !== "unrecognized") return positions;
  const transactions = extractBrokerTransactionsFromSpreadsheet(input);
  return transactions.status === "unrecognized"
    ? extractBalanceSeriesFromSpreadsheet(input)
    : transactions;
}
