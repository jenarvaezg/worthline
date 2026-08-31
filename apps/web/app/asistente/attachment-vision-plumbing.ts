import { parseDecimalStrict } from "@worthline/domain";
import {
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  type Output,
  type Schema,
  zodSchema,
} from "ai";
import { z } from "zod";

import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  type AttachmentExtractionResult,
  extractedDocumentSchema,
  INVALID_OUTPUT_FAILURE,
} from "./attachment-extraction-contract";
import { UNIDENTIFIED_DOCUMENT_MESSAGE } from "./attachment-types";
import {
  classifyVisionProviderFailure,
  VISION_EXTRACTOR_DEFAULT_MODEL,
  VISION_EXTRACTOR_RETRY_DELAYS_MS,
  visionProviderStatusCode,
} from "./attachment-vision";

/**
 * The vision seam's PLUMBING: how a document is asked of the model and how the answer
 * becomes the common envelope — with nothing in it that knows one document family from
 * another (#1699).
 *
 * Everything here is shared by every family and by both calls: the bill and clock
 * ceilings, the retry, the output spec that asks for one shape and accepts another, the
 * provider-failure classification, and the reader of a figure printed as text.
 * A family module reads this file; this file never reads a family module.
 */

export const VISION_EXTRACTOR_MODEL = VISION_EXTRACTOR_DEFAULT_MODEL;

/** The honesty text a reading may carry, bounded identically in both calls. */
export const visionWarningsSchema = z
  .array(z.string().trim().min(1).max(300))
  .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxWarnings)
  .default([]);

/**
 * A figure the PROVIDER writes as TEXT, never as a JSON number.
 *
 * The document that opened #1316 — a broker's trade confirmation — reads correctly
 * and then dies on the way out: asked for `units` as a number, `gemini-3.1-flash-lite`
 * writes `"units": 3.0000…` and keeps padding zeros for the whole 65 520-token
 * ceiling. `finishReason: MAX_TOKENS`, no object, `invalid_output`, and ~140 s of a
 * user waiting pre-stream for a reading that never arrives. At `temperature: 0` the
 * decode is greedy, so the pit is not a bad roll: it reproduced 5/5.
 *
 * Reading every printed figure as text takes the same document back to ~1,6 s and
 * 114 output tokens (2/2). Nothing else came close: flattening the pairs still burned
 * 65 520 tokens, raising the temperature stayed broken, and a newer model closed the
 * JSON with `"units": 3e+99` — a corrupt reading that passes `.finite()`. The seam
 * parses each figure with the domain's own `parseDecimalStrict`, so «54,545» and
 * «1.234,56» land as the number the paper printed and anything else is dropped like
 * any other unusable decoration.
 */
export const visionPrintedNumberSchema = z.string().trim().min(1).max(32);

/**
 * One output spec that ASKS for one shape and ACCEPTS another.
 *
 * Handing `Output.object` a zod schema does two jobs at once: it becomes the JSON
 * schema the provider is constrained by, and it becomes the validator the SDK runs over
 * the reply — a failure there throws `NoObjectGeneratedError` before this seam sees
 * anything. Passing only the required-array shape would therefore make an omitted array
 * a definitive `invalid_output`, which is precisely the dead end #1345 exists to remove:
 * the reply we already know how to read (right document, right total, no rows) has an
 * honest verdict, and it is not «malformed output».
 *
 * The JSON schema still comes from the SDK's own conversion of the asked shape, so the
 * bytes reaching the provider are the ones the bisection measured; only the validator is
 * swapped for the tolerant reading.
 */
export function visionOutputSpec<Value>(
  asked: z.ZodType,
  accepted: z.ZodType<Value>,
): Schema<Value> {
  return jsonSchema<Value>(() => zodSchema(asked).jsonSchema, {
    validate: (value) => {
      const parsed = accepted.safeParse(value);
      return parsed.success
        ? { success: true, value: parsed.data }
        : { success: false, error: parsed.error };
    },
  });
}

/**
 * What one reading costs the money fuse (#1258), reported by the seam because only
 * the seam knows which branch was taken.
 */
export interface VisionExtractionReading {
  result: AttachmentExtractionResult;
  /**
   * Vision calls to CHARGE for this reading — the ask, not the answer: one to
   * identify the document, two when an identified `holding_event` also paid for its
   * detail call, and zero when the refusal was decided over bytes already in memory.
   */
  visionCalls: number;
}

/**
 * Ceilings on ONE extraction call. `maxRetries: 0` bounded how many attempts run and
 * nothing bounded their size or duration — which is how #1316's digit loop turned a
 * ~1,6 s reading into 140 s of a model padding zeros, with the user waiting pre-stream
 * the whole time and the deploy paying for 65 520 output tokens.
 *
 * The token ceiling bounds the BILL: it sits above the largest reading this contract
 * admits (500 rows, against ~114 output tokens for a one-fact document), so no real
 * document is truncated into `invalid_output` by it.
 *
 * The clock bounds the WAIT, and it is the one that fires first on a runaway. Longer
 * than the descriptive call's 12 s because this call may legitimately read a
 * multi-page statement, and short enough that a turn still happens: a reading that
 * needed more than this was not going to be useful pre-stream anyway, and it fails
 * as transient — «vuelve a intentarlo más tarde» — rather than as a bad reading.
 * Per attempt, since a `503` retry deserves its own budget and not the leftovers of
 * the attempt that failed.
 */
export const VISION_EXTRACTOR_MAX_OUTPUT_TOKENS = 24_000;
export const VISION_EXTRACTOR_TIMEOUT_MS = 45_000;

/**
 * The ceiling on the WHOLE reading, across both calls of #1345 and every retry inside
 * them — deliberately the same number the single-call seam could already reach, so
 * splitting the question does not double the wait the user pays pre-stream.
 *
 * Each attempt still gets its own clock (the property #1316 needed), bounded by what is
 * left of this. Without it the arithmetic was three attempts × 45 s × two calls, plus
 * #1246's descriptive 12 s: 282 s of somebody staring at a spinner for a fact measured
 * at ~1,5 s, and no route in this repo declares a `maxDuration` that would stop it
 * sooner.
 */
export const VISION_EXTRACTION_TOTAL_TIMEOUT_MS =
  VISION_EXTRACTOR_TIMEOUT_MS * (VISION_EXTRACTOR_RETRY_DELAYS_MS.length + 1);

/**
 * The detail call is skipped rather than asked with less than this left. A reading that
 * takes ~1,5 s cannot happen in the dregs of a spent budget, so asking would spend the
 * caller's allowance on a request that can only be aborted — and the capture has a
 * better exit: the descriptive lane, which is where every other unread dated fact goes.
 */
export const VISION_DETAIL_MINIMUM_BUDGET_MS = 5_000;

/**
 * The clock ONE attempt gets: its own full budget, or whatever is left of the whole
 * reading's, whichever is smaller — and never negative, because `AbortSignal.timeout`
 * would take a negative number as «abort at once» while reading as an oversight.
 *
 * A function rather than an expression inside the retry loop because it is the
 * arithmetic that caps the split's wait at what a single call could already take, and
 * an `AbortSignal` does not say what it was given: pinned here, it is testable.
 */
export function visionAttemptTimeoutMs(input: {
  deadlineAt: number;
  now: number;
}): number {
  return Math.max(Math.min(VISION_EXTRACTOR_TIMEOUT_MS, input.deadlineAt - input.now), 0);
}

export interface VisionGenerationRequest {
  model: LanguageModel;
  messages: ModelMessage[];
  /**
   * Either call's output spec. `Output.Output` — the SDK's own type — keeps this
   * request shape non-generic over which of the two schemas it carries, while
   * `Output.object` still types each spec against its schema at the call site.
   */
  output: Output.Output;
  maxOutputTokens: number;
  maxRetries: 0;
  temperature: 0;
  abortSignal: AbortSignal;
}

/** The request minus the per-attempt clock, built once and stamped on each try. */
export type VisionGenerationRequestBase = Omit<VisionGenerationRequest, "abortSignal">;

export interface VisionExtractorDependencies {
  env?: Record<string, string | undefined>;
  createModel?: (input: { apiKey: string; modelId: string }) => LanguageModel;
  generate?: (request: VisionGenerationRequest) => Promise<{ output: unknown }>;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Injectable so the shared latency budget below is testable rather than a hope. */
  now?: () => number;
}

export async function defaultGenerate(
  request: VisionGenerationRequest,
): Promise<{ output: unknown }> {
  const result = await generateText(request);
  return { output: result.output };
}

// One voice for both families: the seam no longer knows a "screenshot reader" from a
// "PDF reader", so neither does the copy. The preview card names the file.
export const EXTRACTOR_UNAVAILABLE_FAILURE = {
  code: "extractor_unavailable",
  failure: "transient",
  message:
    "El lector de documentos no está disponible ahora mismo. Puedes seguir conversando y volver a intentarlo más tarde.",
  status: "failure",
} as const satisfies AttachmentExtractionResult;

export const EXTRACTOR_UNCONFIGURED_FAILURE = {
  code: "extractor_unavailable",
  failure: "permanent",
  message:
    "El lector de documentos no está disponible en esta instalación. Puedes seguir conversando sin el archivo.",
  status: "failure",
} as const satisfies AttachmentExtractionResult;

export const EXTRACTOR_CONFIGURATION_FAILURE = {
  code: "extractor_unavailable",
  failure: "permanent",
  message:
    "El lector de documentos no está disponible por un problema de configuración. Puedes seguir conversando sin el archivo.",
  status: "failure",
} as const satisfies AttachmentExtractionResult;

const EXTRACTOR_REJECTED_FAILURE = {
  code: "extractor_rejected",
  failure: "permanent",
  message: "No he podido leer este archivo.",
  status: "failure",
} as const satisfies AttachmentExtractionResult;

export const UNSUPPORTED_DOCUMENT_FAILURE = {
  code: "unsupported_document",
  failure: "permanent",
  message: "El archivo no es un PDF legible.",
  status: "failure",
} as const satisfies AttachmentExtractionResult;

const FAILURE_BY_CATEGORY = {
  configuration: EXTRACTOR_CONFIGURATION_FAILURE,
  rejected: EXTRACTOR_REJECTED_FAILURE,
  unavailable: EXTRACTOR_UNAVAILABLE_FAILURE,
} as const;

function classifyProviderFailure(statusCode: number | null): AttachmentExtractionResult {
  return FAILURE_BY_CATEGORY[classifyVisionProviderFailure(statusCode)];
}

/**
 * The drain #1246's descriptive reading hangs off, marked by a closed field so
 * callers branch on the fact and never on the card's wording.
 */
export function unidentifiedDocument(): AttachmentExtractionResult {
  return {
    message: UNIDENTIFIED_DOCUMENT_MESSAGE,
    reason: "unidentified_document",
    status: "unrecognized",
  };
}

export function validateExtractedDocument(
  candidate: unknown,
): AttachmentExtractionResult {
  const parsed = extractedDocumentSchema.safeParse(candidate);
  return parsed.success ? { data: parsed.data, status: "valid" } : INVALID_OUTPUT_FAILURE;
}

export function isInvalidOutput(result: AttachmentExtractionResult): boolean {
  return result.status === "failure" && result.code === "invalid_output";
}

/**
 * One printed figure as the number the paper showed, or nothing.
 *
 * `parseDecimalStrict` is the domain's own reader, so «54,545» and «1.234,56» mean
 * here exactly what they mean everywhere else in the app instead of whatever a second
 * hand-rolled parser would decide.
 */
export function printedNumber(printed: string | undefined): number | undefined {
  if (printed === undefined) return undefined;
  const value = parseDecimalStrict(printed);
  return value === null || !Number.isFinite(value) ? undefined : value;
}

/** One vision call: the provider's output, or the typed failure it ended in. */
type VisionCallOutcome =
  | { status: "answered"; output: unknown }
  | { status: "failed"; failure: AttachmentExtractionResult };

/**
 * Ask the fixed vision model once, with the bounded retry both calls share: only a
 * `503` is retried, with its own clock per attempt, and every other provider error is
 * classified into the common envelope rather than thrown.
 *
 * `deadlineAt` is the reading's shared ceiling: an attempt gets its own full budget or
 * whatever is left of the whole reading, whichever is smaller.
 */
export async function askVision(input: {
  request: VisionGenerationRequestBase;
  generate: (request: VisionGenerationRequest) => Promise<{ output: unknown }>;
  sleep: (milliseconds: number) => Promise<void>;
  deadlineAt: number;
  now: () => number;
}): Promise<VisionCallOutcome> {
  const { deadlineAt, generate, now, request, sleep } = input;
  for (
    let attempt = 0;
    attempt <= VISION_EXTRACTOR_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    const timeoutMs = visionAttemptTimeoutMs({ deadlineAt, now: now() });
    // The shared budget ran out between attempts. Issuing the request anyway would
    // re-upload up to 4 MiB for an answer that can only be the abort, so the retry
    // stops here with the same transient verdict the abort would have produced.
    if (timeoutMs === 0) {
      return { failure: EXTRACTOR_UNAVAILABLE_FAILURE, status: "failed" };
    }
    try {
      const generated = await generate({
        ...request,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
      return { output: generated.output, status: "answered" };
    } catch (error) {
      if (
        NoOutputGeneratedError.isInstance(error) ||
        NoObjectGeneratedError.isInstance(error)
      ) {
        return { failure: INVALID_OUTPUT_FAILURE, status: "failed" };
      }
      const statusCode = visionProviderStatusCode(error);
      if (statusCode !== 503) {
        return { failure: classifyProviderFailure(statusCode), status: "failed" };
      }
      const delay = VISION_EXTRACTOR_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        return { failure: EXTRACTOR_UNAVAILABLE_FAILURE, status: "failed" };
      }
      await sleep(delay);
    }
  }

  return { failure: EXTRACTOR_UNAVAILABLE_FAILURE, status: "failed" };
}
