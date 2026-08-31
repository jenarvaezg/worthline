import { z } from "zod";

import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  currencySchema,
  extractedNumberSchema,
  nonEmptyStringSchema,
} from "./attachment-extraction-primitives";

/**
 * One position of a portfolio table. `name`, `marketValueEur` and `currency` are the
 * irreducible row — what a position IS — and `ticker`/`units` are optional because the
 * most ordinary screen in retail banking does not print them.
 *
 * That is the whole of this widening. A father rebuilding his managed portfolio uploaded
 * MyInvestor's «Composición» tab — fund name, value in €, return — and the vision model
 * read it correctly: right document, right total, and a warning saying the units were
 * nowhere on screen. With both fields required, the reading had no legal shape to land
 * in: the seam degraded it to `empty_reading` and the chat got neither the total nor the
 * name of a single fund, so the assistant ended up asking for a figure printed on the
 * capture it had just been handed.
 *
 * A row with only its name and value is NOT a degraded reading; it is the honest
 * transcription of a screen that prints nothing else, and it has a first-class
 * destination: the value-only alta (#1325) records it as 1 participación at that value.
 * What stays forbidden is unchanged — a `ticker` or a `units` that the document did not
 * print may never be invented or derived (ADR 0048).
 */
export const extractedPositionSchema = z
  .object({
    ticker: z.string().trim().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(240),
    units: extractedNumberSchema.optional(),
    marketValueEur: extractedNumberSchema,
    currency: currencySchema,
    uncertain: z.boolean().optional(),
  })
  .strict();

/** The positions document: a broker/portfolio table (images and spreadsheets). */
export const positionsDocumentSchema = z
  .object({
    documentType: z.literal("positions"),
    positions: z
      .array(extractedPositionSchema)
      .min(1)
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows),
    totalEur: extractedNumberSchema.optional(),
    warnings: z
      .array(nonEmptyStringSchema)
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxWarnings),
  })
  .strict();

export type ExtractedPosition = z.infer<typeof extractedPositionSchema>;
export type ExtractedPositionsDocument = z.infer<typeof positionsDocumentSchema>;
