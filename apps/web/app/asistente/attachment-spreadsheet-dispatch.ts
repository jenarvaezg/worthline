import type { AttachmentExtractionResult } from "./attachment-extraction-contract";
import {
  extractPositionsAndMovementsFromSpreadsheet,
  type PositionsMovementsExtractionInput,
} from "./attachment-positions-movements-extractor";
import { extractPositionsFromSpreadsheet } from "./attachment-spreadsheet-extractor";

/**
 * Choose the spreadsheet document a workbook is (PRD #1103 S4). The richer
 * positions + movements recognizer runs first; a broker positions table it does
 * not recognize falls through to the existing positions extractor, and an
 * unrecognized sheet there still becomes unstructured context (#865). A definitive
 * failure from the first recognizer is returned as-is — an unreadable workbook is
 * a failure either way, and retrying it as positions would only repeat the error.
 */
export function extractSpreadsheetDocument(
  input: PositionsMovementsExtractionInput,
): AttachmentExtractionResult {
  const reconcile = extractPositionsAndMovementsFromSpreadsheet(input);
  return reconcile.status === "unrecognized"
    ? extractPositionsFromSpreadsheet(input)
    : reconcile;
}
