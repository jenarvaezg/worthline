import { z } from "zod";

import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  currencySchema,
  extractedNumberSchema,
  isoDateSchema,
  nonEmptyStringSchema,
} from "./attachment-extraction-primitives";

/**
 * One dated balance read from a statement or amortization schedule.
 *
 * `projected` is the row's own answer to «¿esto ya pasó?» (#1424). An amortization
 * schedule is half history and half forecast and prints nothing that separates the
 * two halves: the last rows of Jorge's cuadro are dated 2032 and 2034, and the only
 * thing that makes them a forecast rather than an observation is that today is 2026.
 * So the mark is DERIVED, never read and never asked of a model — the reading seam
 * stamps it from the turn's own date (`markProjectedBalances`), which is the one fact
 * the document cannot carry.
 *
 * Optional and stamped only when true, for the reason {@link UNRECOGNIZED_REASONS} is
 * optional: previews already sitting in a client history predate it and must keep
 * revalidating. An absent mark therefore means «not known to be a forecast», which is
 * exactly what a card written before #1424 could honestly claim.
 */
export const datedBalanceSchema = z
  .object({
    date: isoDateSchema,
    amount: extractedNumberSchema,
    currency: currencySchema,
    projected: z.boolean().optional(),
    uncertain: z.boolean().optional(),
  })
  .strict();

/**
 * The dated balance series document: dated balances with their currency. It covers
 * both a debt statement and an amortization schedule, and from either only what the
 * document PRINTS is extracted — never a parameter the model inferred (ADR 0048).
 *
 * What the extractor cannot promise, and stopped pretending to (#1424): that every
 * row is an *observation*. A schedule prints its whole life at once, and the last
 * rows of a 30-year mortgage are the bank's forecast under an interest rate nobody
 * has seen yet. Nothing in the document separates the halves — the turn's own date
 * does, which is why the mark is stamped afterwards, by the reading seam, onto
 * {@link datedBalanceSchema}'s `projected`. The rows still all travel; what changed
 * is that the ones on the far side of today say so.
 */
export const balanceSeriesDocumentSchema = z
  .object({
    documentType: z.literal("balance_series"),
    balances: z
      .array(datedBalanceSchema)
      .min(1)
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows),
    uncertain: z.boolean().optional(),
    warnings: z
      .array(nonEmptyStringSchema)
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxWarnings),
  })
  .strict();

export type DatedBalance = z.infer<typeof datedBalanceSchema>;
export type ExtractedBalanceSeriesDocument = z.infer<typeof balanceSeriesDocumentSchema>;
