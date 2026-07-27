/**
 * Turning a golden question into the turn a provider actually receives (#1254): its
 * attachment read, the frontier that reading opens, and the messages composed.
 *
 * Its own module for two reasons. It is the only part of the harness that touches the
 * filesystem, so the question sets stay pure and importable anywhere. And `run.ts`
 * calls `main()` at import time, which makes anything living there untestable — the
 * composition is exactly what must not be taken on trust, since a harness that sends
 * something other than what it claims scores a model on a turn nobody wrote.
 *
 * Everything here leans on the production seams the chat route runs —
 * {@link readAttachmentTurn}, `prepareAttachmentMessagesForModel`,
 * `unvalidatedEvidenceGateApplies` — so what the model sees in an eval is what a real
 * upload puts in front of it: same extraction verdict, same fences, same frontier. A
 * reimplementation would measure the reimplementation, which is the mistake #1265 had
 * to undo when the harness wired three of six tool stores.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isValidatedDocument,
  prepareAttachmentMessagesForModel,
} from "@web/asistente/attachment-chat";
import {
  type AttachmentTurnReading,
  readAttachmentTurn,
} from "@web/asistente/attachment-turn";
import { attachmentMimeTypeForFileName } from "@web/asistente/attachment-types";
import { unvalidatedEvidenceGateApplies } from "@web/asistente/unvalidated-evidence-gate";
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";

import type { GoldenAttachment, GoldenQuestion } from "./golden-question";

const ATTACHMENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "attachments");

function resolveGoldenAttachmentPath(attachment: GoldenAttachment): string {
  return join(ATTACHMENTS_DIR, attachment.file);
}

/**
 * Which lane the document actually arrived through.
 *
 * It reports one lane a question cannot DECLARE: `dead-end`, the honest verdict of a
 * file worthline could neither validate nor describe (unreadable, too large, a capture
 * nobody could read). No question grades that today — the model holds no document at
 * all there, so the turn is the ordinary manual path — and `GoldenAttachment.lane`
 * deliberately does not offer it rather than inviting a fixture nothing measures. The
 * asymmetry is on purpose: this function has to be able to NAME what it found, because
 * the value of the assertion is the mismatch message, and «no era unstructured» says
 * much less than «llegó como dead-end».
 */
export function laneOf(
  reading: AttachmentTurnReading,
): "unstructured" | "validated" | "dead-end" {
  if (reading.unstructured) return "unstructured";
  return isValidatedDocument(reading.preview) ? "validated" : "dead-end";
}

/**
 * Read one declared attachment and check it is the document the question thinks it is.
 *
 * The lane assertion is the point. Three of the attachment questions grade what the
 * model does NOT do — no bulk import, no proposal over an ambiguous holding — and
 * those checks only mean something while the turn really carries evidence worthline
 * could not validate. A fixture that started validating (a widened header alias) or a
 * file that went missing would hand the model a green it never earned, silently. So a
 * mismatch throws: the runner records the question as errored with every check failed,
 * which is loud in the report and in the exit code.
 */
export async function readGoldenAttachmentTurn(
  attachment: GoldenAttachment,
): Promise<AttachmentTurnReading> {
  const path = resolveGoldenAttachmentPath(attachment);
  const bytes = await readFile(path);
  const reading = await readAttachmentTurn({
    bytes: new Uint8Array(bytes),
    fileName: attachment.file,
    mimeType: attachmentMimeTypeForFileName(attachment.file),
  });
  const lane = laneOf(reading);
  if (lane !== attachment.lane) {
    throw new Error(
      `Attachment ${attachment.file} arrived as "${lane}", not the declared "${attachment.lane}".`,
    );
  }
  return reading;
}

/**
 * The unvalidated-evidence frontier for this turn (#1248), derived exactly as the
 * chat route derives it: from what THIS turn's own extraction produced. Golden
 * questions are single-turn, so the history half of the route's rule cannot apply —
 * there is no earlier turn to have left a trace.
 */
export function unvalidatedEvidenceFor(reading: AttachmentTurnReading | null): boolean {
  return unvalidatedEvidenceGateApplies({
    hasUnvalidatedEvidence: reading?.unstructured != null,
    hasValidatedDocumentInThisTurn: isValidatedDocument(reading?.preview),
  });
}

/**
 * The turn as the model receives it: the question, plus whatever the attachment seam
 * made of its document. Composed by `prepareAttachmentMessagesForModel` — the route's
 * own function — so the fences, the caps and the framing are the production ones.
 *
 * A question with no attachment goes through the same path and comes out as the single
 * user message the runner's old `prompt:` built, so there is one code path rather than
 * two, and no question kind is quietly composed differently from the other.
 */
export async function buildTurnMessages(
  question: GoldenQuestion,
  reading: AttachmentTurnReading | null,
): Promise<ModelMessage[]> {
  const messages: UIMessage[] = [
    { id: question.id, role: "user", parts: [{ type: "text", text: question.question }] },
  ];
  return await convertToModelMessages(
    prepareAttachmentMessagesForModel(
      messages,
      reading?.preview ?? null,
      reading?.unstructured ?? null,
    ),
  );
}
