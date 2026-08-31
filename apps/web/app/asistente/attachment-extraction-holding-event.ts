import { z } from "zod";

import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  currencySchema,
  extractedNumberSchema,
  isinSchema,
  isoDateSchema,
  nonEmptyStringSchema,
} from "./attachment-extraction-primitives";

/**
 * What a dated fact observed on a holding's screen can be (#1244). A CLOSED enum,
 * so the reading can never carry the model's own prose about what happened: the
 * screen said «Amortización anticipada» and that sentence lives in `label`, while
 * this field is the machine-readable half the agent may branch on.
 */
export const HOLDING_EVENT_KINDS = [
  "payment",
  "early_repayment",
  "fee",
  "interest",
  "deposit",
  "withdrawal",
  "other",
] as const;
export type HoldingEventKind = (typeof HOLDING_EVENT_KINDS)[number];

/**
 * The effect the document itself DECLARES the event will have — «tu última cuota
 * se reducirá en 110,64 €». Modelled as a bounded enum and never as free text
 * because it is the one field an agent reads to infer an early repayment's `mode`
 * without the extractor inferring anything (ADR 0048): the screen states it, we
 * relay it, the domain computes the consequence.
 */
export const DECLARED_EFFECT_KINDS = [
  "final_instalment_reduced",
  "instalment_reduced",
  "term_shortened",
  "balance_reduced",
] as const;
export type DeclaredEffectKind = (typeof DECLARED_EFFECT_KINDS)[number];

/**
 * The declared effect, with the figure the screen put on it when it put one. The
 * amount and its currency travel together or not at all: an amount with no
 * currency to read it in cannot be rendered honestly, and a preview that guesses
 * EUR would be inventing exactly what this document exists not to invent.
 */
const declaredEffectSchema = z
  .object({
    kind: z.enum(DECLARED_EFFECT_KINDS),
    amount: extractedNumberSchema.optional(),
    currency: currencySchema.optional(),
  })
  .strict()
  .refine(
    (effect) => (effect.amount === undefined) === (effect.currency === undefined),
    "Un efecto declarado con importe necesita su divisa.",
  );

/**
 * A figure the document PRINTS together with the currency it is printed in. Both
 * halves are required and there is no XOR to refine: an amount with no currency to
 * read it in cannot be rendered honestly, and defaulting to EUR would invent exactly
 * what this contract exists not to invent. An incomplete pair is the vision seam's
 * problem, and it drops the pair with a warning rather than sinking the reading.
 */
const observedMoneySchema = z
  .object({
    amount: extractedNumberSchema,
    currency: currencySchema,
  })
  .strict();

/** The next instalment the screen showed next to the event, when it showed one. */
const nextInstalmentSchema = z
  .object({
    date: isoDateSchema,
    amount: extractedNumberSchema,
    currency: currencySchema,
  })
  .strict();

/**
 * ONE dated fact observed on a holding's screen (#1244) — a payment confirmation,
 * a receipt, a movement, a settlement. Every field is *observed*: nothing here is
 * principal, term, interest rate, resulting balance, or which holding it belongs
 * to. Identifying the holding is the agent's job with its read tools, and the
 * `.strict()` below is what makes that a boundary rather than a wish.
 *
 * `label` is the only free-text surface, carried verbatim from the screen and
 * capped exactly like every other string in this contract — it reaches the model
 * pool inside the structured block, so its bound is a real frontier, not a hint.
 */
const holdingEventSchema = z
  .object({
    date: isoDateSchema,
    amount: extractedNumberSchema,
    currency: currencySchema,
    label: nonEmptyStringSchema,
    kind: z.enum(HOLDING_EVENT_KINDS),
    /**
     * What a securities trade confirmation PRINTS next to the settled amount (#1316):
     * ISIN, títulos, precio bruto por título, comisión. These do not relax the
     * frontier above — they are ink on the document, as observed as `amount` itself,
     * and every one of them is optional because most events (a receipt, a loan
     * payment) print none. What stays forbidden is unchanged: nothing here is
     * derived, `units × pricePerUnit` is never computed, and the ISIN identifies the
     * INSTRUMENT the paper names, never which holding of the user's it belongs to —
     * that remains the agent's job with its read tools.
     */
    isin: isinSchema.optional(),
    units: extractedNumberSchema.optional(),
    pricePerUnit: observedMoneySchema.optional(),
    fees: observedMoneySchema.optional(),
    declaredEffect: declaredEffectSchema.optional(),
    nextInstalment: nextInstalmentSchema.optional(),
    uncertain: z.boolean().optional(),
  })
  .strict();

/**
 * The holding-event document: exactly ONE observed fact, deliberately not a list.
 *
 * The singular is the lock this slice waited for, and it is worth being precise
 * about what it does and does not close. A validated document exempts its turn from
 * the unvalidated-evidence gate *and* from that gate's one-proposal-per-turn cap
 * (#1248, `unvalidatedEvidenceGateApplies`), so a `holding_event` carrying twelve
 * events would have been twelve uncapped proposals in a single turn — the bulk
 * import the frontier reserves for the deterministic route, walking through the one
 * door nobody counts. With a single `event` that variant has no number to count.
 *
 * What it does NOT close, precisely: once a turn brings any validated document the
 * gate short-circuits before the budget is even consulted, so that turn has NO cap
 * of any kind — and `validatedDocumentsInContext` keeps the last three, so by the
 * third upload a turn holds three validated facts at once and may propose against
 * all of them. What this shape removes is bringing twelve facts through the door in
 * a SINGLE upload; the per-turn exemption itself is inherited, is documented as an
 * accepted cost on the gate, and is bounded only by that three-document window. The
 * alternative lock (teaching the cap to count facts instead of reading provenance)
 * stays available and is the one to reach for if that exemption ever needs closing.
 *
 * A screen showing several dated facts is therefore NOT this document. It is not
 * lost: the vision seam declines to identify it and it reaches the model through
 * #1246's descriptive lane, where the gate and its cap apply in full.
 */
export const holdingEventDocumentSchema = z
  .object({
    documentType: z.literal("holding_event"),
    event: holdingEventSchema,
    uncertain: z.boolean().optional(),
    warnings: z
      .array(nonEmptyStringSchema)
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxWarnings),
  })
  .strict();

export type ExtractedHoldingEventDocument = z.infer<typeof holdingEventDocumentSchema>;
/** The ONE observed fact a holding-event document carries (#1244, #1316). */
export type ExtractedHoldingEvent = ExtractedHoldingEventDocument["event"];
