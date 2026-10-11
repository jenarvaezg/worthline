import { z } from "zod";

import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  currencySchema,
  declaresOneIdentifierAtMost,
  dgsCodeSchema,
  extractedNumberSchema,
  isinSchema,
  isoDateSchema,
  nonEmptyStringSchema,
  observedMoneySchema,
  TWO_IDENTIFIERS_MESSAGE,
} from "./attachment-extraction-primitives";

/**
 * Which half of a traspaso the paper CONFIRMS (#1795). A bank sends one notice per
 * half: the «reembolso por traspaso» when the origin is redeemed, and the «suscripción
 * por traspaso» when the destination is subscribed. Both name the two funds, but the
 * participaciones and the VL they print belong to ONE half only — the redemption's are
 * the units that LEFT the origin, the subscription's the units that ARRIVED in the
 * destination — so a reading that did not say which would leave the figure without a
 * side, and the side is exactly what the traspaso lane needs to know (#1544).
 *
 * Read off the paper's own words, never derived: the operation's literal text sits in
 * `label` next to it so the card can show what the classification was made from.
 */
export const TRANSFER_CONFIRMED_HALVES = ["redemption", "subscription"] as const;
export type TransferConfirmedHalf = (typeof TRANSFER_CONFIRMED_HALVES)[number];

/** A figure that is a MAGNITUDE: the direction of a traspaso is `confirms`, not a sign. */
const positiveFigureSchema = extractedNumberSchema.refine(
  (value) => value > 0,
  "Debe ser mayor que cero.",
);

/**
 * One side of the traspaso as the paper names it: the fund's printed name and AT MOST
 * one identifier — an ISIN with its check digit, or the DGS code of a plan (#1454,
 * #1747). Which of the user's holdings it is stays the traspaso lane's question, decided
 * by that identifier against the book; this reading only carries the ink.
 */
const transferFundSchema = z
  .object({
    name: nonEmptyStringSchema,
    isin: isinSchema.optional(),
    dgsCode: dgsCodeSchema.optional(),
  })
  .strict()
  .refine(declaresOneIdentifierAtMost, TWO_IDENTIFIERS_MESSAGE);

/**
 * ONE traspaso between two funds (or two plans) as its confirmation prints it (#1795).
 *
 * Every field is OBSERVED (ADR 0048). `date` is the fecha de operación and only that:
 * never the fecha valor, never a day borrowed from elsewhere on the paper — the value
 * date is the day the VL was struck, and a traspaso anotado on it lands on a day the
 * bank never executed the order. `amount` is the gross importe; the paper's own net
 * figure, if it prints one, is not carried because the fee next to it already says
 * the difference and a second copy of the same arithmetic is a figure that can drift.
 *
 * The participaciones and the VL are of the CONFIRMED half (`confirms`), and both are
 * optional: they are what the traspaso lane reads first, but a paper that does not
 * print them is still the confirmation of a traspaso, and the vision seam drops an
 * unreadable one out loud rather than inventing it.
 */
const transferSchema = z
  .object({
    date: isoDateSchema,
    confirms: z.enum(TRANSFER_CONFIRMED_HALVES),
    label: nonEmptyStringSchema,
    origin: transferFundSchema,
    destination: transferFundSchema,
    units: positiveFigureSchema.optional(),
    pricePerUnit: observedMoneySchema.optional(),
    amount: positiveFigureSchema,
    currency: currencySchema,
    fees: observedMoneySchema.optional(),
    uncertain: z.boolean().optional(),
  })
  .strict();

/**
 * The traspaso document: exactly ONE traspaso, deliberately not a list — the lock of
 * the holding-event document (#1244), for the same reason. A validated document lifts
 * the unvalidated-evidence gate and its one-proposal-per-turn cap (#1248), so a paper
 * listing several traspasos would be several uncapped proposals through the one door
 * nobody counts. Such a paper is not this document: the vision seam declines it and it
 * reaches the model through the descriptive lane, where the gate applies in full.
 */
export const transferDocumentSchema = z
  .object({
    documentType: z.literal("transfer"),
    transfer: transferSchema,
    uncertain: z.boolean().optional(),
    warnings: z
      .array(nonEmptyStringSchema)
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxWarnings),
  })
  .strict();

export type ExtractedTransferDocument = z.infer<typeof transferDocumentSchema>;
/** The ONE traspaso a transfer document carries (#1795). */
export type ExtractedTransfer = ExtractedTransferDocument["transfer"];
