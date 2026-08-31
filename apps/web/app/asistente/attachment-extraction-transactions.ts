import { z } from "zod";

import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  currencySchema,
  isinSchema,
  isoDateSchema,
  nonEmptyStringSchema,
  positiveDecimalStringSchema,
} from "./attachment-extraction-primitives";

/** What a broker transactions row can be: the ledger prints trades, nothing else. */
export const TRANSACTION_KINDS = ["buy", "sell"] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/**
 * ONE executed trade read off a broker's transactions export (#1487).
 *
 * It is deliberately NOT `extractedMovementSchema`: a movement of a portfolio
 * sheet hangs off a holdings table that states what each row is worth today, while this
 * row is the ledger itself and carries what an operation needs to be WRITTEN — the
 * gross amount, the unit price, the costs the broker charged, and the order reference
 * that lets a re-import recognize the same trade (#1488).
 *
 * `isin` or `name` is required for the same reason a movement needs one: a trade that
 * cannot be attributed to an instrument could never become an operation. The ISIN is the
 * strong key and the one a real export prints (ADR 0055 routes by it).
 */
export const extractedTransactionSchema = z
  .object({
    date: isoDateSchema,
    kind: z.enum(TRANSACTION_KINDS),
    isin: isinSchema.optional(),
    name: z.string().trim().min(1).max(240).optional(),
    units: positiveDecimalStringSchema,
    /** The gross amount of the trade, fees EXCLUDED, in `currency`. */
    amount: positiveDecimalStringSchema,
    /** `amount ÷ units` as the reader derived it — never re-derived downstream. */
    pricePerUnit: positiveDecimalStringSchema,
    currency: currencySchema,
    /** Costs printed on the row, in `currency`'s minor units. Absent means none. */
    feesMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    /** The broker's order reference, when the export prints one. */
    orderId: z.string().trim().min(1).max(120).optional(),
    uncertain: z.boolean().optional(),
  })
  .strict()
  .refine(
    (transaction) => Boolean(transaction.isin) || Boolean(transaction.name),
    "Una transacción necesita ISIN o nombre para vincularse a una inversión.",
  );

export type ExtractedTransaction = z.infer<typeof extractedTransactionSchema>;

/**
 * The broker transactions document (#1487): a ledger and nothing else — no positions
 * table, because a transactions export does not carry one.
 *
 * That absence is the whole reason it exists as its own type. `positions_movements`
 * requires the holdings table its movements hang off, so the most standard file a broker
 * exports had no shape to land in: Jorge's DEGIRO `Transactions.xlsx` was refused by
 * both lanes, which then closed the unvalidated-evidence gate (#1248) for the rest of
 * the conversation — the same inversion #1417 had to remove for the amortization
 * schedule, one document further along.
 *
 * Its destination is the statement import that already exists (PRD #173): these rows ARE
 * the `ParsedStatementRow`s that gate consumes, so the card, the ISIN routing and the
 * all-or-nothing merge were already built. What was missing was the reader.
 */
export const brokerTransactionsDocumentSchema = z
  .object({
    documentType: z.literal("broker_transactions"),
    transactions: z
      .array(extractedTransactionSchema)
      .min(1)
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows),
    uncertain: z.boolean().optional(),
    warnings: z
      .array(nonEmptyStringSchema)
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxWarnings),
  })
  .strict();

export type ExtractedBrokerTransactionsDocument = z.infer<
  typeof brokerTransactionsDocumentSchema
>;
