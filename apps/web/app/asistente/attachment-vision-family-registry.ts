import type { AttachmentExtractionResult } from "./attachment-extraction-contract";
import { balanceSeriesVisionFamily } from "./attachment-vision-balance-series-family";
import type { VisionDetailCall, VisionDocumentFamily } from "./attachment-vision-family";
import { holdingEventVisionFamily } from "./attachment-vision-holding-event-family";
import type {
  VisionFamilyDocumentType,
  VisionIdentification,
} from "./attachment-vision-identification";
import { unidentifiedDocument } from "./attachment-vision-plumbing";
import { positionsVisionFamily } from "./attachment-vision-positions-family";
import { brokerTransactionsVisionFamily } from "./attachment-vision-transactions-family";

/**
 * THE REGISTRY: the one place that lists the document families of the vision seam.
 *
 * Adding a family is a new module implementing `VisionDocumentFamily`, its enum value in
 * the identification schema, and one line here. The `Record` is keyed by
 * `VisionFamilyDocumentType`, so forgetting the line is a compile error rather than a
 * document that silently reads as nothing.
 */
const VISION_FAMILY_BY_DOCUMENT_TYPE: Record<
  VisionFamilyDocumentType,
  VisionDocumentFamily
> = {
  balance_series: balanceSeriesVisionFamily,
  broker_transactions: brokerTransactionsVisionFamily,
  holding_event: holdingEventVisionFamily,
  positions: positionsVisionFamily,
};

/**
 * Turn the identification into the common envelope. Only the identified document's own
 * family reads it, so a model that filled both tables cannot smuggle the other one
 * through, and the branded contract validates the result a second time.
 */
export function documentFromIdentification(
  output: VisionIdentification,
): AttachmentExtractionResult {
  if (output.documentType === "none") {
    return unidentifiedDocument();
  }
  return VISION_FAMILY_BY_DOCUMENT_TYPE[output.documentType].fromIdentification(output);
}

/**
 * Which SECOND question this document earns, if any (#1345's split, widened by #1487 to
 * the ledger): a dated fact read in detail, or a ledger's rows. Both live outside the
 * identification schema because both are fat branches, and the budget that schema has is
 * the one thing the bisection measured.
 */
export function visionDetailCallFor(
  output: VisionIdentification,
): VisionDetailCall | null {
  if (output.documentType === "none") return null;
  const detail = VISION_FAMILY_BY_DOCUMENT_TYPE[output.documentType].detail;
  return detail !== undefined && detail.earnedBy(output) ? detail : null;
}
