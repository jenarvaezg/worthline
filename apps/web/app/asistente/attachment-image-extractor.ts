import { createGoogle } from "@ai-sdk/google";
import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
} from "ai";
import { z } from "zod";

import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  type AttachmentExtractionResult,
  checkAttachmentLimits,
  extractedPositionsSchema,
} from "./attachment-extraction-contract";

export const IMAGE_EXTRACTOR_DEFAULT_MODEL = "gemini-3.1-flash-lite";

const IMAGE_EXTRACTOR_RETRY_DELAYS_MS = [250, 750] as const;

/**
 * Deliberately plain vision schema: the model can report an empty positions
 * array, which the seam maps to `unrecognized`. Non-empty output is parsed a
 * second time by the branded common contract before it can reach chat.
 */
const imagePositionsOutputSchema = z
  .object({
    positions: z
      .array(
        z
          .object({
            ticker: z.string().trim().min(1).max(64),
            name: z.string().trim().min(1).max(240),
            units: z.number().finite(),
            marketValueEur: z.number().finite(),
            currency: z
              .string()
              .trim()
              .regex(/^[A-Z]{3}$/),
            uncertain: z.boolean().optional(),
          })
          .strict(),
      )
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows),
    totalEur: z.number().finite().optional(),
    warnings: z.array(z.string().trim().min(1).max(300)).max(20),
  })
  .strict();

type ImagePositionsOutput = z.infer<typeof imagePositionsOutputSchema>;

export interface ImageAttachmentInput {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}

interface ImageGenerationRequest {
  model: LanguageModel;
  messages: ModelMessage[];
  output: ReturnType<typeof Output.object<ImagePositionsOutput>>;
  maxRetries: 0;
  temperature: 0;
}

interface ImageExtractorDependencies {
  env?: Record<string, string | undefined>;
  createModel?: (input: { apiKey: string; modelId: string }) => LanguageModel;
  generate?: (request: ImageGenerationRequest) => Promise<{ output: unknown }>;
  sleep?: (milliseconds: number) => Promise<void>;
}

function defaultCreateModel({
  apiKey,
  modelId,
}: {
  apiKey: string;
  modelId: string;
}): LanguageModel {
  return createGoogle({ apiKey })(modelId);
}

async function defaultGenerate(
  request: ImageGenerationRequest,
): Promise<{ output: unknown }> {
  const result = await generateText(request);
  return { output: result.output };
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function providerStatusCode(error: unknown): number | null {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current === null || typeof current !== "object") return null;
    const statusCode = (current as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number") return statusCode;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

const INVALID_OUTPUT_FAILURE = {
  code: "invalid_output",
  failure: "permanent",
  message: "El extractor devolvió datos incompletos o malformados.",
  status: "failure",
} as const satisfies AttachmentExtractionResult;

const EXTRACTOR_UNAVAILABLE_FAILURE = {
  code: "extractor_unavailable",
  failure: "transient",
  message:
    "El lector de capturas no está disponible ahora mismo. Puedes seguir conversando y volver a intentarlo más tarde.",
  status: "failure",
} as const satisfies AttachmentExtractionResult;

const EXTRACTOR_UNCONFIGURED_FAILURE = {
  code: "extractor_unavailable",
  failure: "permanent",
  message:
    "El lector de capturas no está disponible en esta instalación. Puedes seguir conversando sin la captura.",
  status: "failure",
} as const satisfies AttachmentExtractionResult;

const EXTRACTOR_CONFIGURATION_FAILURE = {
  code: "extractor_unavailable",
  failure: "permanent",
  message:
    "El lector de capturas no está disponible por un problema de configuración. Puedes seguir conversando sin la captura.",
  status: "failure",
} as const satisfies AttachmentExtractionResult;

const EXTRACTOR_REJECTED_FAILURE = {
  code: "extractor_rejected",
  failure: "permanent",
  message: "No he podido leer esta captura.",
  status: "failure",
} as const satisfies AttachmentExtractionResult;

function classifyProviderFailure(statusCode: number | null): AttachmentExtractionResult {
  if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
    return EXTRACTOR_CONFIGURATION_FAILURE;
  }
  if (
    statusCode === 400 ||
    statusCode === 413 ||
    statusCode === 415 ||
    statusCode === 422
  ) {
    return EXTRACTOR_REJECTED_FAILURE;
  }
  return EXTRACTOR_UNAVAILABLE_FAILURE;
}

/**
 * One-purpose image extractor. Pixels are passed only to the fixed Google
 * vision model and discarded with this call; callers receive the common,
 * validated JSON contract and never provider output directly.
 */
export async function extractPositionsFromImage(
  input: ImageAttachmentInput,
  dependencies: ImageExtractorDependencies = {},
): Promise<AttachmentExtractionResult> {
  const limitFailure = checkAttachmentLimits({
    fileName: input.fileName,
    kind: "image",
    mimeType: input.mimeType,
    sizeBytes: input.bytes.byteLength,
  });
  if (limitFailure) return limitFailure;

  const env = dependencies.env ?? process.env;
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!apiKey) return EXTRACTOR_UNCONFIGURED_FAILURE;

  const modelId = env.WORTHLINE_EXTRACTOR_MODEL?.trim() || IMAGE_EXTRACTOR_DEFAULT_MODEL;
  const createModel = dependencies.createModel ?? defaultCreateModel;
  const generate = dependencies.generate ?? defaultGenerate;
  const sleep = dependencies.sleep ?? defaultSleep;
  let model: LanguageModel;
  try {
    model = createModel({ apiKey, modelId });
  } catch {
    return EXTRACTOR_CONFIGURATION_FAILURE;
  }
  const request: ImageGenerationRequest = {
    maxRetries: 0,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Lee únicamente las posiciones de inversión visibles en la captura.",
              "Mantén ticker y nombre en campos separados; no uses el nombre como ticker.",
              "No inventes valores ni símbolos. Marca uncertain y añade un warning concreto ante cualquier duda.",
              "Devuelve positions vacío si la imagen no contiene una cartera reconocible.",
              "marketValueEur y totalEur son importes en EUR; no inventes conversiones que no aparezcan en pantalla.",
            ].join(" "),
          },
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
    output: Output.object({
      description: "Posiciones de inversión leídas de una captura de broker",
      name: "broker_positions",
      schema: imagePositionsOutputSchema,
    }),
    temperature: 0,
  };

  for (let attempt = 0; attempt <= IMAGE_EXTRACTOR_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const generated = await generate(request);
      const visionOutput = imagePositionsOutputSchema.safeParse(generated.output);
      if (!visionOutput.success) return INVALID_OUTPUT_FAILURE;
      if (visionOutput.data.positions.length === 0) {
        return {
          message: "No reconozco posiciones de inversión en esta captura.",
          status: "unrecognized",
        };
      }

      const commonOutput = extractedPositionsSchema.safeParse(visionOutput.data);
      return commonOutput.success
        ? { data: commonOutput.data, status: "valid" }
        : INVALID_OUTPUT_FAILURE;
    } catch (error) {
      if (
        NoOutputGeneratedError.isInstance(error) ||
        NoObjectGeneratedError.isInstance(error)
      ) {
        return INVALID_OUTPUT_FAILURE;
      }
      const statusCode = providerStatusCode(error);
      if (statusCode !== 503) return classifyProviderFailure(statusCode);
      const delay = IMAGE_EXTRACTOR_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) return EXTRACTOR_UNAVAILABLE_FAILURE;
      await sleep(delay);
    }
  }

  return EXTRACTOR_UNAVAILABLE_FAILURE;
}
