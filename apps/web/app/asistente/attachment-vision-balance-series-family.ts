import type { AttachmentExtractionResult } from "./attachment-extraction-contract";
import type { VisionDocumentFamily } from "./attachment-vision-family";
import { validateExtractedDocument } from "./attachment-vision-plumbing";

/**
 * The BALANCE SERIES family of the vision seam: the dated balances of a debt, read from
 * a statement or from an amortization schedule by the cheap call. Like positions, its
 * row is small enough to live in the identification schema, so it asks no second
 * question — and, per ADR 0048, only observed balances travel: never a cuota, a rate or
 * any other parameter the model could infer.
 */

export const EMPTY_BALANCE_SERIES_MESSAGE =
  "Reconozco una serie de saldos fechados, pero no he podido leer ninguna fila.";

export const balanceSeriesVisionFamily: VisionDocumentFamily = {
  documentType: "balance_series",
  fromIdentification(output): AttachmentExtractionResult {
    const balances = output.balances ?? [];
    if (balances.length === 0) {
      return {
        message: EMPTY_BALANCE_SERIES_MESSAGE,
        reason: "empty_reading",
        status: "unrecognized",
      };
    }
    return validateExtractedDocument({
      balances,
      documentType: "balance_series",
      warnings: output.warnings,
      ...(output.uncertain === undefined ? {} : { uncertain: output.uncertain }),
    });
  },
};
