import { z } from "zod";

import { balanceSeriesDocumentSchema } from "./attachment-extraction-balance-series";
import { holdingEventDocumentSchema } from "./attachment-extraction-holding-event";
import { positionsDocumentSchema } from "./attachment-extraction-positions";
import { positionsMovementsDocumentSchema } from "./attachment-extraction-positions-movements";
import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  ATTACHMENT_LIMIT_REASONS,
  type AttachmentLimitReason,
  EXTRACTOR_FAILURE_CODES,
  EXTRACTOR_FAILURE_KINDS,
  type ExtractorFailureCode,
  type ExtractorFailureKind,
  UNRECOGNIZED_REASONS,
  type UnrecognizedReason,
} from "./attachment-extraction-primitives";
import { brokerTransactionsDocumentSchema } from "./attachment-extraction-transactions";
import { MAX_ATTACHMENT_FILE_NAME_CHARS } from "./attachment-types";

/**
 * The envelope every extractor answers in, and the ONE registry of document families:
 * the discriminated union below is where a new family joins the contract, and the only
 * place that has to learn its name.
 */

interface BaseAttachmentLimitInput {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export type AttachmentLimitInput =
  | (BaseAttachmentLimitInput & { kind: "image" })
  | (BaseAttachmentLimitInput & { kind: "spreadsheet"; rowCount: number })
  | (BaseAttachmentLimitInput & { kind: "pdf"; pageCount: number });

export type AttachmentExtractionResult =
  | { status: "valid"; data: ExtractedDocument }
  | { status: "unrecognized"; message: string; reason?: UnrecognizedReason | undefined }
  | { status: "out_of_limits"; reason: AttachmentLimitReason; message: string }
  | {
      status: "failure";
      failure: ExtractorFailureKind;
      code: ExtractorFailureCode;
      message: string;
    };

/**
 * The one validated payload shape reaching chat: a discriminated union of
 * document schemas. The envelope (valid/unrecognized/out_of_limits/failure) is
 * unchanged; only the shape of a valid extraction widened beyond positions.
 */
export const extractedDocumentSchema = z
  .discriminatedUnion("documentType", [
    positionsDocumentSchema,
    balanceSeriesDocumentSchema,
    positionsMovementsDocumentSchema,
    brokerTransactionsDocumentSchema,
    holdingEventDocumentSchema,
  ])
  .brand<"ValidatedExtractedDocument">();

export type ExtractedDocument = z.infer<typeof extractedDocumentSchema>;

const nonEmptyMessageSchema = z.string().trim().min(1);
const extractionResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("valid"),
      data: extractedDocumentSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unrecognized"),
      message: nonEmptyMessageSchema,
      reason: z.enum(UNRECOGNIZED_REASONS).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("out_of_limits"),
      reason: z.enum(ATTACHMENT_LIMIT_REASONS),
      message: nonEmptyMessageSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("failure"),
      failure: z.enum(EXTRACTOR_FAILURE_KINDS),
      code: z.enum(EXTRACTOR_FAILURE_CODES),
      message: nonEmptyMessageSchema,
    })
    .strict(),
]);

/** The one definitive failure for malformed/partial output, shared by extractors. */
export const INVALID_OUTPUT_FAILURE = {
  code: "invalid_output",
  failure: "permanent",
  message: "El extractor devolvió datos incompletos o malformados.",
  status: "failure",
} as const satisfies AttachmentExtractionResult;

/**
 * Parse the complete extractor seam. Invalid or partial payloads become an
 * explicit definitive failure, so callers can never treat raw model output as
 * conversational context.
 */
export function parseExtractionResult(input: unknown): AttachmentExtractionResult {
  const parsed = extractionResultSchema.safeParse(input);
  return parsed.success ? parsed.data : INVALID_OUTPUT_FAILURE;
}

/** Validate type, byte size and per-family bounds before doing extraction work. */
export function checkAttachmentLimits(
  input: AttachmentLimitInput,
): Extract<AttachmentExtractionResult, { status: "out_of_limits" }> | null {
  const trimmedFileName = input.fileName.trim();
  if (trimmedFileName.length > MAX_ATTACHMENT_FILE_NAME_CHARS) {
    return {
      message: "El nombre del archivo supera el límite de 255 caracteres.",
      reason: "type",
      status: "out_of_limits",
    };
  }

  const fileName = trimmedFileName.toLowerCase();
  const mimeType = input.mimeType.trim().toLowerCase();
  const acceptedType = ATTACHMENT_EXTRACTION_LIMITS_V1.acceptedTypes.find((type) =>
    type.extensions.some((extension) => fileName.endsWith(extension)),
  );
  const hasCompatibleMetadata =
    acceptedType !== undefined &&
    acceptedType.kind === input.kind &&
    mimeType !== "" &&
    acceptedType.mimeTypes.some((accepted) => accepted === mimeType);

  if (!hasCompatibleMetadata) {
    return {
      message: "Solo se admiten archivos PNG, JPEG, WebP, HEIC/HEIF, CSV, XLSX o PDF.",
      reason: "type",
      status: "out_of_limits",
    };
  }
  if (input.sizeBytes > ATTACHMENT_EXTRACTION_LIMITS_V1.maxBytes) {
    return {
      message: "El archivo supera el límite de 4 MB.",
      reason: "size",
      status: "out_of_limits",
    };
  }
  if (
    input.kind === "spreadsheet" &&
    input.rowCount > ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows
  ) {
    return {
      message: "La hoja supera el límite de 500 filas.",
      reason: "rows",
      status: "out_of_limits",
    };
  }
  if (
    input.kind === "pdf" &&
    input.pageCount > ATTACHMENT_EXTRACTION_LIMITS_V1.maxPdfPages
  ) {
    return {
      message: `El PDF supera el límite de ${ATTACHMENT_EXTRACTION_LIMITS_V1.maxPdfPages} páginas.`,
      reason: "pages",
      status: "out_of_limits",
    };
  }

  return null;
}
