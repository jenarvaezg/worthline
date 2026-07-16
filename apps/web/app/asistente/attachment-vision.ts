import { createGoogle } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

/**
 * Shared plumbing for the dedicated vision extractors (ADR 0063). Screenshots and
 * PDFs are read by the same fixed Google model, outside the conversational pool.
 * Only the provider mechanics live here; each extractor keeps its own document
 * contract, prompt and user-facing failure copy.
 */

export const VISION_EXTRACTOR_DEFAULT_MODEL = "gemini-3.1-flash-lite";

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
