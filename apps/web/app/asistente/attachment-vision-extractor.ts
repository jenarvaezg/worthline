import { type LanguageModel, Output } from "ai";

import { INVALID_OUTPUT_FAILURE } from "./attachment-extraction-contract";
import { looksLikePdf } from "./attachment-pdf-bytes";
import {
  defaultCreateVisionModel,
  defaultVisionSleep,
  resolveVisionModelId,
  type VisionAttachmentInput,
  visionAttachmentLimitFailure,
} from "./attachment-vision";
import {
  documentFromIdentification,
  visionDetailCallFor,
} from "./attachment-vision-family-registry";
import {
  VISION_EXTRACTION_INSTRUCTIONS,
  visionIdentificationRequestSchema,
  visionIdentificationSchema,
} from "./attachment-vision-identification";
import {
  askVision,
  defaultGenerate,
  EXTRACTOR_CONFIGURATION_FAILURE,
  EXTRACTOR_UNCONFIGURED_FAILURE,
  isInvalidOutput,
  UNSUPPORTED_DOCUMENT_FAILURE,
  unidentifiedDocument,
  VISION_DETAIL_MINIMUM_BUDGET_MS,
  VISION_EXTRACTION_TOTAL_TIMEOUT_MS,
  VISION_EXTRACTOR_MAX_OUTPUT_TOKENS,
  type VisionExtractionReading,
  type VisionExtractorDependencies,
  type VisionGenerationRequestBase,
  visionOutputSpec,
} from "./attachment-vision-plumbing";

/**
 * The ORCHESTRATOR of the vision seam: it asks the identification call, hands the answer
 * to the family that claims it, and pays for a second call only when that family says the
 * document earns one.
 *
 * Everything it used to carry itself now lives in one of three kinds of module (#1699):
 * the generic plumbing (`attachment-vision-plumbing`), the identification call
 * (`attachment-vision-identification`), and one module per document family, listed in
 * `attachment-vision-family-registry`. This file knows how a reading FLOWS and nothing
 * about what any single document is.
 */

export { EMPTY_BALANCE_SERIES_MESSAGE } from "./attachment-vision-balance-series-family";
// The published surface, unchanged: callers and tests import these from here.
export {
  DROPPED_DECLARED_EFFECT_WARNING,
  DROPPED_FEES_WARNING,
  DROPPED_ISIN_WARNING,
  DROPPED_NEXT_INSTALMENT_WARNING,
  DROPPED_PRICE_PER_UNIT_WARNING,
  DROPPED_UNITS_WARNING,
  EMPTY_HOLDING_EVENT_MESSAGE,
} from "./attachment-vision-holding-event-family";
export {
  VISION_DETAIL_MINIMUM_BUDGET_MS,
  VISION_EXTRACTION_TOTAL_TIMEOUT_MS,
  VISION_EXTRACTOR_MAX_OUTPUT_TOKENS,
  VISION_EXTRACTOR_MODEL,
  VISION_EXTRACTOR_TIMEOUT_MS,
  type VisionExtractionReading,
  visionAttemptTimeoutMs,
} from "./attachment-vision-plumbing";
export {
  EMPTY_POSITIONS_MESSAGE,
  WHOLE_READING_UNCERTAIN_WARNING,
} from "./attachment-vision-positions-family";
export { EMPTY_TRANSACTIONS_MESSAGE } from "./attachment-vision-transactions-family";

/**
 * The one vision seam (ADR 0063, amended by #1243 and #1345): it identifies the
 * document behind an image or a PDF and extracts it. The binary is passed only to the
 * fixed Google vision model and discarded with the reading — never persisted, never
 * seen by the conversational pool — and callers receive the common, validated JSON
 * contract instead of provider output, together with the number of calls it cost.
 *
 * **One call identifies and extracts; a second one reads a `holding_event` in
 * detail.** The unification of #1243 was a single call for every document, and that
 * held until #1316 grew the event branch: `gemini-3.1-flash-lite` has a schema
 * complexity budget, and the fattened `events` branch stopped a bank's «Composición»
 * capture from yielding a single `positions` row — the model read the seven funds, put
 * their sum in a warning, and emitted an empty array (see the identification schema for
 * the bisection). Every other document therefore costs exactly what it did before, and
 * only an identified dated fact pays for the richer read.
 */
export async function extractDocumentFromVisionAttachment(
  input: VisionAttachmentInput,
  dependencies: VisionExtractorDependencies = {},
): Promise<VisionExtractionReading> {
  // Decided over bytes already in memory, before any provider is reached — so these
  // two refusals cost nothing and must not spend the caller's allowance (#1258).
  const limitFailure = visionAttachmentLimitFailure(input);
  if (limitFailure) return { result: limitFailure, visionCalls: 0 };
  if (input.kind === "pdf" && !looksLikePdf(input.bytes)) {
    return { result: UNSUPPORTED_DOCUMENT_FAILURE, visionCalls: 0 };
  }

  const env = dependencies.env ?? process.env;
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  // Charged as one call even though none was made. A broken install's envelope is
  // indistinguishable from a request the provider really did reject, and for a fuse
  // over-counting is the safe direction while under-counting is the one that stops it
  // from holding.
  if (!apiKey) return { result: EXTRACTOR_UNCONFIGURED_FAILURE, visionCalls: 1 };

  const modelId = resolveVisionModelId(env);
  const createModel = dependencies.createModel ?? defaultCreateVisionModel;
  const generate = dependencies.generate ?? defaultGenerate;
  const sleep = dependencies.sleep ?? defaultVisionSleep;
  const now = dependencies.now ?? Date.now;
  const deadlineAt = now() + VISION_EXTRACTION_TOTAL_TIMEOUT_MS;
  let model: LanguageModel;
  try {
    model = createModel({ apiKey, modelId });
  } catch {
    return { result: EXTRACTOR_CONFIGURATION_FAILURE, visionCalls: 1 };
  }

  const requestFor = (
    instructions: string,
    output: Output.Output,
  ): VisionGenerationRequestBase => ({
    maxOutputTokens: VISION_EXTRACTOR_MAX_OUTPUT_TOKENS,
    maxRetries: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: instructions },
          {
            type: "file",
            data: { type: "data", data: input.bytes },
            filename: input.fileName,
            mediaType: input.mimeType,
          },
        ],
      },
    ],
    model,
    output,
    temperature: 0,
  });

  const identifyCall = await askVision({
    deadlineAt,
    generate,
    now,
    request: requestFor(
      VISION_EXTRACTION_INSTRUCTIONS,
      Output.object({
        description: "Documento financiero identificado y leído de un adjunto",
        name: "financial_document",
        schema: visionOutputSpec(
          visionIdentificationRequestSchema,
          visionIdentificationSchema,
        ),
      }),
    ),
    sleep,
  });
  if (identifyCall.status === "failed") {
    return { result: identifyCall.failure, visionCalls: 1 };
  }
  const identification = visionIdentificationSchema.safeParse(identifyCall.output);
  if (!identification.success) {
    return { result: INVALID_OUTPUT_FAILURE, visionCalls: 1 };
  }
  const detail = visionDetailCallFor(identification.data);
  if (detail === null) {
    return {
      result: documentFromIdentification(identification.data),
      visionCalls: 1,
    };
  }

  // No time left for a real reading: the capture takes the descriptive lane instead of
  // paying for a request that could only be aborted (see
  // {@link VISION_DETAIL_MINIMUM_BUDGET_MS}). It takes an identification that spent the
  // whole budget — a slow one, or a `503` storm — to get here, and the alternative,
  // «vuelve a intentarlo» over a document we did identify, gives the conversation less.
  if (deadlineAt - now() < VISION_DETAIL_MINIMUM_BUDGET_MS) {
    return { result: unidentifiedDocument(), visionCalls: 1 };
  }

  const detailCall = await askVision({
    deadlineAt,
    generate,
    now,
    request: requestFor(detail.instructions, detail.output()),
    sleep,
  });
  // Charged on the ASK, not on the answer, exactly like #1246's descriptive cascade:
  // the request was made, so the fuse counts it whatever came back.
  //
  // Output this seam cannot read DECLINES rather than fails, whether the provider sent
  // no object at all or one the schema refuses. That is #1244's rule and it holds here
  // for the same reason: the document WAS identified, so the capture still deserves the
  // descriptive lane instead of the dead end `invalid_output` is. It is not a
  // hypothetical either — «no object generated» is one of the ways the fat schema
  // failed in the bisection above. A provider that could not be reached keeps its own
  // transient verdict, because «vuelve a intentarlo» is honest and a retry gets the
  // whole reading rather than half of it.
  if (detailCall.status === "failed") {
    return {
      result: isInvalidOutput(detailCall.failure)
        ? unidentifiedDocument()
        : detailCall.failure,
      visionCalls: 2,
    };
  }
  return {
    result: detail.read(detailCall.output, identification.data),
    visionCalls: 2,
  };
}
