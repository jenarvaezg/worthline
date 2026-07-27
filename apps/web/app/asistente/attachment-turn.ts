import type {
  AttachmentPreviewData,
  UnstructuredAttachment,
} from "@web/asistente/attachment-chat";
import { extractSpreadsheetDocument } from "@web/asistente/attachment-spreadsheet-dispatch";
import { renderSpreadsheetForContext } from "@web/asistente/attachment-spreadsheet-extractor";
import {
  UNSTRUCTURED_SPREADSHEET_MESSAGE,
  UNSTRUCTURED_VISION_MESSAGE,
} from "@web/asistente/attachment-types";
import { visionAttachmentKind } from "@web/asistente/attachment-vision";
import { describeVisionAttachment } from "@web/asistente/attachment-vision-description";
import { extractDocumentFromVisionAttachment } from "@web/asistente/attachment-vision-extractor";

/**
 * What ONE attachment becomes when it arrives in a turn (PRD #1241) — the card the
 * user reads, and the lane through which the document (or only its verdict) reaches
 * the model.
 *
 * It lived inside `api/chat/route.ts` until #1254, which is where it stopped being
 * enough: the assistant eval could not attach a file, so no behaviour of this seam
 * entered the comparison between models — «does it ask when the holding is ambiguous?
 * does it respect the unvalidated-evidence frontier?» were ungradeable questions. The
 * harness now runs THIS module rather than a copy of it, for the same reason the eval
 * wires the route's own tool slice instead of a subset (#1265): a second copy measures
 * the copy. Everything policy-shaped — quotas, the paywall, rate limits, cooldowns —
 * stays in the route, because it is about the caller, not about the document.
 */
export interface AttachmentTurnInput {
  bytes: Uint8Array;
  /** As the user's file arrives; trimmed here, at the one place that reads it. */
  fileName: string;
  mimeType: string;
}

export interface AttachmentTurnReading {
  /** The extraction verdict, always shown to the user (#1242). */
  preview: AttachmentPreviewData;
  /**
   * Evidence worthline could NOT validate, handed to the model to discuss (#865,
   * #1246). Non-null is exactly what opens the unvalidated-evidence gate (#1248),
   * so the caller derives that flag from this field rather than guessing from MIME.
   */
  unstructured: UnstructuredAttachment | null;
  /**
   * What reading this document cost: billed vision calls, 0 to 2 (#1258). A
   * spreadsheet is 0 — no model touches it. An identified document is 1. A capture
   * the seam does not identify is 2, because it also pays for a description.
   *
   * It belongs to the reading and not to the route because only the reading knows
   * which branches it took, and because the eval harness runs this same seam: the
   * cost of the cascade is measurable there for the same reason its behaviour is.
   * What to DO about the number — whose budget it spends — stays with the caller.
   */
  visionCalls: number;
}

/**
 * Read one attachment: identify the document, and choose the lane it travels in.
 *
 * The MIME type picks the *transport* only (#1243): one vision seam identifies the
 * document behind an image or a PDF by its content, while a spreadsheet keeps its
 * stronger, deterministic, model-free route.
 */
export async function readAttachmentTurn(
  input: AttachmentTurnInput,
): Promise<AttachmentTurnReading> {
  const fileName = input.fileName.trim();
  const extractionInput = { bytes: input.bytes, fileName, mimeType: input.mimeType };
  const visionKind = visionAttachmentKind(fileName, input.mimeType);
  const isSpreadsheet = visionKind === null;

  // Every billed vision call of the cascade lands here, so the caller gets ONE number
  // for what reading this document cost (#1258) instead of inferring it from the lane.
  let visionCalls = 0;
  const onVisionCall = (): void => {
    visionCalls += 1;
  };

  const result =
    visionKind === null
      ? extractSpreadsheetDocument(extractionInput)
      : await extractDocumentFromVisionAttachment(
          { ...extractionInput, kind: visionKind },
          { onVisionCall },
        );

  // A readable spreadsheet that is not a positions table becomes conversational
  // material instead of a dead-end (#865): render the whole book and let the model
  // describe it — never as validated figures.
  if (result.status === "unrecognized" && isSpreadsheet) {
    const text = renderSpreadsheetForContext(extractionInput);
    if (text) {
      return {
        preview: {
          fileName,
          result: { message: UNSTRUCTURED_SPREADSHEET_MESSAGE, status: "unrecognized" },
        },
        unstructured: { fileName, source: "spreadsheet_grid", text },
        visionCalls,
      };
    }
  }

  // Parity for pixels (#1246): a capture whose document the seam did not identify had
  // no drain at all, so it died on the card. A SECOND call to the same fixed model
  // outside the pool says what is on screen, and it enters the turn through the very
  // same unstructured lane, with the same defenses. Only this branch pays for it: an
  // identified document — or one identified and read empty (`empty_reading`) — needs no
  // description, and the user waits for it pre-stream. `!isSpreadsheet` is not
  // redundant with the reason: the deterministic sheet route never stamps this
  // discriminant today, and this keeps a future one that did from sending a workbook to
  // a vision model and clobbering its own rendered grid.
  if (
    visionKind !== null &&
    result.status === "unrecognized" &&
    result.reason === "unidentified_document"
  ) {
    const description = await describeVisionAttachment(
      { ...extractionInput, kind: visionKind },
      { onVisionCall },
    );
    if (description) {
      return {
        preview: {
          fileName,
          result: {
            message: UNSTRUCTURED_VISION_MESSAGE,
            reason: "unidentified_document",
            status: "unrecognized",
          },
        },
        unstructured: { fileName, source: "vision_description", text: description },
        visionCalls,
      };
    }
  }

  // Any other non-valid verdict (unreadable, unrecognized, out of limits) does NOT end
  // the turn (#1242): the preview card carries the message and the conversational model
  // gets the verdict alone — never content it never read — so it can say what happened,
  // ask what the document is and offer the manual route instead of a canned line.
  return { preview: { fileName, result }, unstructured: null, visionCalls };
}
