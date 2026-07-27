import { createGoogle } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

import {
  type AttachmentExtractionResult,
  checkAttachmentLimits,
} from "./attachment-extraction-contract";
import { countPdfPages } from "./attachment-pdf-bytes";

/**
 * Shared plumbing for the dedicated vision extractors (ADR 0063). Screenshots and
 * PDFs are read by the same fixed Google model, outside the conversational pool.
 * Only the provider mechanics live here; each extractor keeps its own document
 * contract, prompt and user-facing failure copy.
 */

export const VISION_EXTRACTOR_DEFAULT_MODEL = "gemini-3.1-flash-lite";

/** Which file family carries the document. It decides transport and guards only. */
export type VisionAttachmentKind = "image" | "pdf";

/**
 * Which vision lane an attachment travels in, or `null` when none does — a
 * spreadsheet, whose deterministic model-free route owns it.
 *
 * Exported because the answer is needed BEFORE the reading runs as well as inside it:
 * the chat route has to know whether this attachment is about to spend from the
 * extraction budget (#1258), and it must reach that answer the same way the reading
 * does. A second copy of the MIME rule would be a fuse that disagrees with the lane
 * it guards. The extension fallback stands because a browser can send an empty type.
 */
export function visionAttachmentKind(
  fileName: string,
  mimeType: string,
): VisionAttachmentKind | null {
  const normalizedMime = mimeType.toLowerCase();
  if (normalizedMime === "application/pdf" || fileName.toLowerCase().endsWith(".pdf")) {
    return "pdf";
  }
  return normalizedMime.startsWith("image/") ? "image" : null;
}

/**
 * Told once per vision model call this reading paid for (#1258).
 *
 * «Paid for» is *the provider did the work*, not *the answer was useful*. It fires on a
 * good reading, on output that fails the schema, on a rejection, and on our own
 * timeout — all of those handed the document to the model, and a fuse that only
 * charged the successful ones would hand the caller a free lane: choose a file that
 * reliably times out or defeats the schema and read for nothing. The single exception
 * is a `503`, where the provider was too busy to start: charging that would blow a
 * caller's fuse during an outage they did not cause.
 *
 * The observer lives in the shared plumbing rather than in each extractor because the
 * cost of reading ONE attachment is spread across two entry points in cascade (#1246):
 * only their sum is the number a fuse can be built on.
 */
export interface VisionCallObserver {
  /** Invoked once per billed vision call. Optional: an unobserved reading still works. */
  onVisionCall?: (() => void) | undefined;
}

/** True when a failure means the provider never got to work, so nothing was spent. */
export function isUnbilledVisionFailure(error: unknown): boolean {
  return visionProviderStatusCode(error) === 503;
}

/** One attachment as the vision seam receives it, shared by every reading of it. */
export interface VisionAttachmentInput {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  kind: VisionAttachmentKind;
}

/**
 * Type, byte-size and per-family bounds, before any model work. It lives with the
 * shared input type rather than inside one reading because EVERY reading of an
 * attachment owes the same check: the extraction (#1243) and the descriptive reading
 * (#1246) are separate exported entry points, so an order-of-calls convention is not
 * a boundary. Re-running it is a handful of comparisons plus a page count over bytes
 * already in memory — cheap enough that no caller has a reason to skip it.
 */
export function visionAttachmentLimitFailure(
  input: VisionAttachmentInput,
): Extract<AttachmentExtractionResult, { status: "out_of_limits" }> | null {
  const base = {
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.byteLength,
  };
  return checkAttachmentLimits(
    input.kind === "pdf"
      ? { ...base, kind: "pdf", pageCount: countPdfPages(input.bytes) ?? 0 }
      : { ...base, kind: "image" },
  );
}

/** Bounded backoff for a `503` (busy) provider. Every other error fails fast. */
export const VISION_EXTRACTOR_RETRY_DELAYS_MS = [250, 750] as const;

export function defaultCreateVisionModel({
  apiKey,
  modelId,
}: {
  apiKey: string;
  modelId: string;
}): LanguageModel {
  return createGoogle({ apiKey })(modelId);
}

export function defaultVisionSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Walk a small cause chain looking for a provider HTTP status code. */
export function visionProviderStatusCode(error: unknown): number | null {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current === null || typeof current !== "object") return null;
    const statusCode = (current as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number") return statusCode;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export type VisionFailureCategory = "configuration" | "rejected" | "unavailable";

/** Map a provider status code to a category each extractor renders in its voice. */
export function classifyVisionProviderFailure(
  statusCode: number | null,
): VisionFailureCategory {
  if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
    return "configuration";
  }
  if (
    statusCode === 400 ||
    statusCode === 413 ||
    statusCode === 415 ||
    statusCode === 422
  ) {
    return "rejected";
  }
  return "unavailable";
}

export function resolveVisionModelId(env: Record<string, string | undefined>): string {
  return env.WORTHLINE_EXTRACTOR_MODEL?.trim() || VISION_EXTRACTOR_DEFAULT_MODEL;
}
