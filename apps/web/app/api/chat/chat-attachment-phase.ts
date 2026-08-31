/**
 * This turn's attachment: read it, log what it cost, charge it (#1697, extracted from
 * `route.ts`).
 *
 * What the document IS, and the lane it travels in, is one seam (#1254) — shared with
 * the assistant eval so a run grades this behaviour rather than a copy of it. What
 * stays on this side is what is about the CALLER: the money fuse's counter and the
 * operational line.
 */

import type { AttachmentPreviewData } from "@web/asistente/attachment-chat";
import {
  readAttachmentTurn,
  type UnstructuredReading,
} from "@web/asistente/attachment-turn";
import { chatAsOf } from "@web/asistente/chat-clock";
import type { StoreTarget } from "@web/store-resolver";

import { type MeteredVisionScope, recordTurnVisionCalls } from "./chat-quota-gates";

export interface TurnAttachmentReading {
  preview: AttachmentPreviewData | null;
  unstructured: UnstructuredReading | null;
}

/** Nothing was uploaded: the shape every downstream phase reads as «no attachment». */
export const NO_TURN_ATTACHMENT: TurnAttachmentReading = {
  preview: null,
  unstructured: null,
};

export async function readTurnAttachment(input: {
  attachment: File;
  nowIso: string;
  target: StoreTarget;
  visionMeter: MeteredVisionScope | null;
}): Promise<TurnAttachmentReading> {
  const { attachment, nowIso, target, visionMeter } = input;
  const reading = await readAttachmentTurn({
    bytes: new Uint8Array(await attachment.arrayBuffer()),
    fileName: attachment.name,
    mimeType: attachment.type,
    // The SAME date the tools value at, not `nowIso` (#1424): a demo target runs on
    // a pinned clock, and a reading that called half a schedule «previsión» against
    // a different today than the curve it feeds would contradict its own card.
    today: chatAsOf(target),
  });
  if (reading.visionCalls > 0) {
    // Visible even where nothing is metered (local dev, demo without a control
    // plane): «how much do we spend on extraction» had no answer at all before
    // this, and one line per reading is the cheapest half of one. Aggregate
    // only — a count and the kind of caller, never the file or the scope key.
    console.info("Assistant attachment vision calls", {
      targetKind: target.kind,
      visionCalls: reading.visionCalls,
    });
  }
  recordTurnVisionCalls(visionMeter, nowIso, reading.visionCalls);
  return { preview: reading.preview, unstructured: reading.unstructured };
}
