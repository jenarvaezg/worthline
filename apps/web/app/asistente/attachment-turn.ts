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
   * How many vision model calls this reading paid for (#1258) — the number the
   * caller's fuse counts. Zero for the deterministic spreadsheet route, one for a
   * document the seam identified, two when the descriptive cascade also ran.
   *
   * The seam reports it because only the seam knows: the extractors hand back a
   * validated verdict and never provider usage, and a policy layer reading MIME
   * types would be guessing at the branch that was actually taken.
   */
  visionCalls: number;
}

/** Which transport a file travels in — the MIME type picks it, and only it (#1243). */
function visionTransport(input: {
  fileName: string;
  mimeType: string;
}): "image" | "pdf" | null {
  const mimeType = input.mimeType.toLowerCase();
  if (mimeType === "application/pdf" || input.fileName.toLowerCase().endsWith(".pdf")) {
    return "pdf";
  }
  return mimeType.startsWith("image/") ? "image" : null;
}

/**
 * Will this file reach a vision model at all? Exported for the caller's money fuse
 * (#1258), which must not brake an upload that costs nothing: a spreadsheet takes
 * the deterministic, model-free route, so refusing one on a spent allowance would
 * be both a lie and a needless dead end. The transport decision lives HERE, in the
 * seam that acts on it, so the gate and the reading can never disagree about which
 * lane a file is in.
 */
export function isVisionAttachment(input: {
  fileName: string;
  mimeType: string;
}): boolean {
  return (
    visionTransport({ fileName: input.fileName.trim(), mimeType: input.mimeType }) !==
    null
  );
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
  const visionKind = visionTransport({ fileName, mimeType: input.mimeType });
  const isSpreadsheet = visionKind === null;

  const result = isSpreadsheet
    ? extractSpreadsheetDocument(extractionInput)
    : await extractDocumentFromVisionAttachment({ ...extractionInput, kind: visionKind });

  // What this reading owes the money fuse (#1258). Three outcomes cost nothing and
  // must not spend the caller's daily allowance: the deterministic sheet route, a
  // file the contract refused on its size or page count, and a "PDF" whose bytes are
  // not a PDF — all three decided over bytes already in memory, before any provider
  // is reached. Every other outcome is charged as one call, INCLUDING an unconfigured
  // deploy, whose failure envelope is indistinguishable from a request the provider
  // really did reject: over-counting a broken install is the safe direction for a
  // fuse, and under-counting is the one that stops it from holding.
  const reachedNoProvider =
    isSpreadsheet ||
    result.status === "out_of_limits" ||
    (result.status === "failure" && result.code === "unsupported_document");
  const extractionCalls = reachedNoProvider ? 0 : 1;

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
        visionCalls: 0,
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
  const describes =
    !isSpreadsheet &&
    result.status === "unrecognized" &&
    result.reason === "unidentified_document";
  const description = describes
    ? await describeVisionAttachment({ ...extractionInput, kind: visionKind })
    : null;
  // Charged on the ASK, not on the answer (#1258): a description the provider failed
  // to give back still cost a request, and it is the branch below — not the outcome —
  // that the abuse the fuse guards against reaches for.
  const visionCalls = extractionCalls + (describes ? 1 : 0);

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

  // Any other non-valid verdict (unreadable, unrecognized, out of limits) does NOT end
  // the turn (#1242): the preview card carries the message and the conversational model
  // gets the verdict alone — never content it never read — so it can say what happened,
  // ask what the document is and offer the manual route instead of a canned line.
  return { preview: { fileName, result }, unstructured: null, visionCalls };
}
