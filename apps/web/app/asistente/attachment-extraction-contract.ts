import { z } from "zod";

import { ATTACHMENT_TYPES_V1, MAX_ATTACHMENT_FILE_NAME_CHARS } from "./attachment-types";

const MEBIBYTE = 1024 * 1024;
const ATTACHMENT_LIMIT_REASONS = ["rows", "size", "type"] as const;
const EXTRACTOR_FAILURE_KINDS = ["permanent", "transient"] as const;
const EXTRACTOR_FAILURE_CODES = [
  "extractor_rejected",
  "extractor_unavailable",
  "invalid_output",
  "unsupported_document",
] as const;

/** The complete v1 attachment envelope, shared by image and spreadsheet extractors. */
export const ATTACHMENT_EXTRACTION_LIMITS_V1 = {
  acceptedTypes: ATTACHMENT_TYPES_V1,
  // Vercel Functions reject request bodies above 4.5 MB before the route runs.
  // Four MiB leaves room for multipart framing and the text conversation while
  // keeping every accepted upload inside the deployed transport boundary.
  maxBytes: 4 * MEBIBYTE,
  maxRows: 500,
} as const;

export type AttachmentLimitReason = (typeof ATTACHMENT_LIMIT_REASONS)[number];
export type ExtractorFailureKind = (typeof EXTRACTOR_FAILURE_KINDS)[number];
export type ExtractorFailureCode = (typeof EXTRACTOR_FAILURE_CODES)[number];

interface BaseAttachmentLimitInput {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export type AttachmentLimitInput =
  | (BaseAttachmentLimitInput & { kind: "image" })
  | (BaseAttachmentLimitInput & { kind: "spreadsheet"; rowCount: number });

export type AttachmentExtractionResult =
  | { status: "valid"; data: ExtractedPositions }
  | { status: "unrecognized"; message: string }
  | { status: "out_of_limits"; reason: AttachmentLimitReason; message: string }
  | {
      status: "failure";
      failure: ExtractorFailureKind;
      code: ExtractorFailureCode;
      message: string;
    };

/**
 * Normalize a number emitted as JSON or read from a Spanish-formatted sheet.
 * Spanish grouping wins for ambiguous string values: `1.234` means 1234, while
 * a real JSON number remains unambiguous and is returned unchanged.
 */
export function normalizeExtractedNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;

  const compact = value.trim().replace(/[\s\u00a0\u202f]/g, "");
  if (!compact) return null;

  let normalized: string;
  if (/^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(compact)) {
    normalized = compact.replace(/\./g, "").replace(",", ".");
  } else if (/^[+-]?\d+(?:,\d+)?$/.test(compact)) {
    normalized = compact.replace(",", ".");
  } else if (/^[+-]?\d+(?:\.\d+)?$/.test(compact)) {
    normalized = compact;
  } else if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(compact)) {
    normalized = compact.replace(/,/g, "");
  } else {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

const extractedNumberSchema = z.preprocess(
  (value) => normalizeExtractedNumber(value) ?? value,
  z.number().finite(),
);
const nonEmptyStringSchema = z.string().trim().min(1).max(300);

export const extractedPositionSchema = z
  .object({
    ticker: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(240),
    units: extractedNumberSchema,
    marketValueEur: extractedNumberSchema,
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/),
    uncertain: z.boolean().optional(),
  })
  .strict();

/** The one validated payload shape produced by both screenshots and spreadsheets. */
export const extractedPositionsSchema = z
  .object({
    positions: z
      .array(extractedPositionSchema)
      .min(1)
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows),
    totalEur: extractedNumberSchema.optional(),
    warnings: z.array(nonEmptyStringSchema).max(20),
  })
  .strict()
  .brand<"ValidatedExtractedPositions">();

export type ExtractedPosition = z.infer<typeof extractedPositionSchema>;
export type ExtractedPositions = z.infer<typeof extractedPositionsSchema>;

const nonEmptyMessageSchema = z.string().trim().min(1);
const extractionResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("valid"),
      data: extractedPositionsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unrecognized"),
      message: nonEmptyMessageSchema,
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

const INVALID_OUTPUT_FAILURE = {
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

/** Validate type, byte size and spreadsheet rows before doing extraction work. */
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
      message: "Solo se admiten archivos PNG, JPEG, WebP, HEIC/HEIF, CSV o XLSX.",
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

  return null;
}
