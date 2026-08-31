import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  type AttachmentExtractionResult,
} from "./attachment-extraction-contract";
import type { VisionDocumentFamily } from "./attachment-vision-family";
import type { VisionIdentification } from "./attachment-vision-identification";
import { validateExtractedDocument } from "./attachment-vision-plumbing";

/**
 * The POSITIONS family of the vision seam: a portfolio table read by the cheap call.
 * It asks no second question — a position is name, value and currency, and those fit in
 * the identification schema's own branch.
 */

/**
 * "I identified the document and read no rows" — a different fact from
 * `UNIDENTIFIED_DOCUMENT_MESSAGE`, sharing its `unrecognized` status.
 */
export const EMPTY_POSITIONS_MESSAGE =
  "Reconozco un listado de posiciones, pero no he podido leer ninguna fila.";

/**
 * How a whole-document `uncertain` survives into a `positions` reading. The positions
 * contract has no document-level uncertainty field (a `balance_series` does), so the
 * flag would otherwise be dropped on the floor — and it is the one honesty signal the
 * model volunteered about the reading as a whole. Recorded as a warning, which the
 * preview card already paints, and phrased as a report of what the extractor said
 * rather than as our own interpretation.
 */
export const WHOLE_READING_UNCERTAIN_WARNING =
  "El extractor marcó la lectura completa como dudosa.";

type VisionPosition = NonNullable<VisionIdentification["positions"]>[number];
/** The position as the CONTRACT wants it: no blank strings, no impossible counts. */
type ContractPosition = Omit<VisionPosition, "ticker" | "units"> & {
  ticker?: string;
  units?: number;
};

/**
 * One position with its two optional fields reduced to «printed or absent».
 *
 * Both drops are SILENT, and that is the same rule the event decorations follow rather
 * than an exception to it: a warning is owed when the reading loses something the screen
 * showed, and neither of these is that. An empty `ticker` is a model answering «no hay
 * símbolo» in the only way a required string can; a `units` of zero next to a positive
 * value is arithmetically not a units count, so no paper printed it. Announcing either as
 * a loss would put a caveat on the card about something the document never said — and a
 * `units: 0` kept verbatim is worse: the preview would paint «0» beside 1.413,63 € and
 * the alta bridge would silently refuse to price a row that reads perfectly well as
 * value-only.
 */
function usablePosition(position: VisionPosition): ContractPosition {
  const { ticker, units, ...rest } = position;
  return {
    ...rest,
    ...(ticker === undefined || ticker.trim() === "" ? {} : { ticker }),
    ...(units === undefined || units <= 0 ? {} : { units }),
  };
}

/**
 * The reading's warnings, carrying a whole-document `uncertain` as
 * {@link WHOLE_READING_UNCERTAIN_WARNING}. The mark takes the LAST slot when the model
 * already filled the cap: a 21st warning would breach the contract and turn an
 * otherwise good reading into `invalid_output`, and the caveat about the reading as a
 * whole outweighs one more per-row note.
 */
function warningsWithUncertaintyMark(output: VisionIdentification): string[] {
  if (!output.uncertain) return [...output.warnings];
  return [
    ...output.warnings.slice(0, ATTACHMENT_EXTRACTION_LIMITS_V1.maxWarnings - 1),
    WHOLE_READING_UNCERTAIN_WARNING,
  ];
}

export const positionsVisionFamily: VisionDocumentFamily = {
  documentType: "positions",
  fromIdentification(output): AttachmentExtractionResult {
    const positions = (output.positions ?? []).map(usablePosition);
    if (positions.length === 0) {
      return {
        message: EMPTY_POSITIONS_MESSAGE,
        reason: "empty_reading",
        status: "unrecognized",
      };
    }
    return validateExtractedDocument({
      documentType: "positions",
      positions,
      warnings: warningsWithUncertaintyMark(output),
      ...(output.totalEur === undefined ? {} : { totalEur: output.totalEur }),
    });
  },
};
