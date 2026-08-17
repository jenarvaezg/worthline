import { extractBalanceSeriesFromSpreadsheet } from "./attachment-balance-series-extractor";
import type { AttachmentExtractionResult } from "./attachment-extraction-contract";
import {
  extractPositionsAndMovementsFromSpreadsheet,
  type PositionsMovementsExtractionInput,
} from "./attachment-positions-movements-extractor";
import { extractPositionsFromSpreadsheet } from "./attachment-spreadsheet-extractor";

/**
 * Choose the spreadsheet document a workbook is (PRD #1103 S4). The richer
 * positions + movements recognizer runs first; a broker positions table it does
 * not recognize falls through to the existing positions extractor, then to the dated
 * balance series of a statement or amortization schedule (#1417), and a sheet none of
 * them recognizes still becomes unstructured context (#865). A definitive failure from
 * an earlier recognizer is returned as-is — an unreadable workbook is a failure either
 * way, and retrying it as another document would only repeat the error.
 *
 * The order is the two portfolio documents first because their headers are the
 * specific ones: a balance series asks only for a date and a balance, which a
 * portfolio sheet with a `Saldo` column would also satisfy.
 */
export function extractSpreadsheetDocument(
  input: PositionsMovementsExtractionInput,
): AttachmentExtractionResult {
  const reconcile = extractPositionsAndMovementsFromSpreadsheet(input);
  if (reconcile.status !== "unrecognized") return reconcile;
  const positions = extractPositionsFromSpreadsheet(input);
  return positions.status === "unrecognized"
    ? extractBalanceSeriesFromSpreadsheet(input)
    : positions;
}
