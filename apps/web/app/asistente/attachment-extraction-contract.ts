import { normalizeDecimal } from "@worthline/domain";
import { z } from "zod";

import { ATTACHMENT_TYPES_V1, MAX_ATTACHMENT_FILE_NAME_CHARS } from "./attachment-types";

const MEBIBYTE = 1024 * 1024;
const ATTACHMENT_LIMIT_REASONS = ["rows", "size", "type", "pages"] as const;
/**
 * Why nothing was extracted — the two facts `unrecognized` carries since #1243. It is
 * a closed field and not a comparison against the card's copy because #1246 BRANCHES
 * on the distinction: only `unidentified_document` (no document recognized at all) is
 * the drain a descriptive reading hangs off, while `empty_reading` means the document
 * was recognized and no row could be read. Optional on purpose — previews already
 * sitting in a client history predate it and must keep revalidating.
 */
const UNRECOGNIZED_REASONS = ["unidentified_document", "empty_reading"] as const;
const EXTRACTOR_FAILURE_KINDS = ["permanent", "transient"] as const;
const EXTRACTOR_FAILURE_CODES = [
  "extractor_rejected",
  "extractor_unavailable",
  "invalid_output",
  "unsupported_document",
] as const;

/** The complete v1 attachment envelope, shared by every extractor route. */
export const ATTACHMENT_EXTRACTION_LIMITS_V1 = {
  acceptedTypes: ATTACHMENT_TYPES_V1,
  // Vercel Functions reject request bodies above 4.5 MB before the route runs.
  // Four MiB leaves room for multipart framing and the text conversation while
  // keeping every accepted upload inside the deployed transport boundary.
  maxBytes: 4 * MEBIBYTE,
  maxRows: 500,
  // Honesty text, not payload: enough room for a per-row caveat on a small reading
  // without letting an untrusted document push unbounded prose into chat context.
  maxWarnings: 20,
  // A dated statement or amortization schedule that reads cleanly fits well under
  // this bound; the cap keeps a pathological multi-hundred-page PDF from being
  // handed to the vision model inside the request boundary.
  maxPdfPages: 20,
} as const;

export type AttachmentLimitReason = (typeof ATTACHMENT_LIMIT_REASONS)[number];
export type UnrecognizedReason = (typeof UNRECOGNIZED_REASONS)[number];
export type ExtractorFailureKind = (typeof EXTRACTOR_FAILURE_KINDS)[number];
export type ExtractorFailureCode = (typeof EXTRACTOR_FAILURE_CODES)[number];

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
const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/);

/**
 * True when `value` is `YYYY-MM-DD` AND a real day on the calendar. Exported so a
 * caller can ASK before handing a date to the contract — the vision seam uses it to
 * drop an unreadable optional date instead of failing an otherwise good reading.
 */
export function isIsoDay(value: string): boolean {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false;
  const [year, month, day] = trimmed.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** An ISO calendar date (`YYYY-MM-DD`) that is also a real day. */
const isoDateSchema = z
  .string()
  .trim()
  .refine(isIsoDay, "La fecha debe ser un día válido en formato YYYY-MM-DD.");

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

/**
 * The ISIN shape: two letters, nine alphanumerics and a check digit. Strict enough
 * that a provider symbol or free text can never masquerade as one.
 */
const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** True when `value`, once uppercased and trimmed, is a well-formed ISIN. */
export function isValidIsin(value: string): boolean {
  return ISIN_PATTERN.test(value.trim().toUpperCase());
}

/**
 * An ISIN as it may appear in a portfolio sheet. Uppercased before validating so a
 * lowercase cell is accepted.
 */
const isinSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.string().regex(ISIN_PATTERN, "El ISIN debe tener 12 caracteres válidos."),
);

/** How the operations of a portfolio movement read (buy / sell / contribution). */
export const MOVEMENT_KINDS = ["buy", "sell", "contribution"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/**
 * The honesty tier of a holding's cost basis (decision #1090, ADR 0048). It is a
 * **derived** mark — never invented — computed from what the document actually
 * carries, so the reconcile surface (S5) can paint each row's data quality:
 * - `movements` — dated buys/sells back the position: a real cost basis;
 * - `declared_cost` — no movements, but the sheet states a cost;
 * - `value_only` — only a current value: the "sin coste real" mark.
 */
export const HOLDING_FIDELITY_TIERS = [
  "movements",
  "declared_cost",
  "value_only",
] as const;
export type HoldingFidelity = (typeof HOLDING_FIDELITY_TIERS)[number];

/**
 * One holding read from an arbitrary portfolio sheet — the reconcile input
 * (decision #1090). The `type` label is preserved **verbatim** as the user wrote
 * it (mapping it to a domain instrument is the reconcile's job, not the
 * extractor's — ADR 0048 forbids inventing a classification). `value` is the
 * current market value in major units; `declaredCost` is present only when the
 * sheet states one. `fidelity` is stamped by the extractor via
 * {@link resolveHoldingFidelity} and re-derivable from the envelope.
 */
export const extractedHoldingSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    type: z.string().trim().min(1).max(120),
    isin: isinSchema.optional(),
    value: extractedNumberSchema,
    currency: currencySchema,
    declaredCost: extractedNumberSchema.optional(),
    fidelity: z.enum(HOLDING_FIDELITY_TIERS),
    uncertain: z.boolean().optional(),
  })
  .strict();

/**
 * One dated movement (compra/venta/aportación) read from a portfolio sheet. It
 * links back to a holding by the strong key (ISIN) or the weak key (name); at
 * least one is required, or the movement could never be attributed. `units` is
 * present only for buys/sells that report a quantity.
 */
export const extractedMovementSchema = z
  .object({
    date: isoDateSchema,
    kind: z.enum(MOVEMENT_KINDS),
    isin: isinSchema.optional(),
    name: z.string().trim().min(1).max(240).optional(),
    units: extractedNumberSchema.optional(),
    amount: extractedNumberSchema,
    currency: currencySchema,
    uncertain: z.boolean().optional(),
  })
  .strict()
  .refine(
    (movement) => Boolean(movement.isin) || Boolean(movement.name),
    "Un movimiento necesita ISIN o nombre para vincularse a un holding.",
  );

export type ExtractedHolding = z.infer<typeof extractedHoldingSchema>;
export type ExtractedMovement = z.infer<typeof extractedMovementSchema>;

function normalizeHoldingName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** True when a movement attributes to a holding by ISIN (strong) or name (weak). */
export function movementLinksToHolding(
  movement: Pick<ExtractedMovement, "isin" | "name">,
  holding: Pick<ExtractedHolding, "isin" | "name">,
): boolean {
  const isinMatch = Boolean(movement.isin) && movement.isin === holding.isin;
  const nameMatch =
    Boolean(movement.name) &&
    normalizeHoldingName(movement.name ?? "") === normalizeHoldingName(holding.name);
  return isinMatch || nameMatch;
}

/**
 * The honest cost-basis tier for a holding, derived from the envelope alone. This
 * is the single source of the fidelity mark: the extractor stamps it and the
 * reconcile surface can re-derive it, so the tier can never drift from the data
 * (ADR 0048 — no tier is claimed without the movements or cost to back it).
 */
export function resolveHoldingFidelity(
  holding: Pick<ExtractedHolding, "isin" | "name" | "declaredCost">,
  movements: readonly Pick<ExtractedMovement, "isin" | "name">[],
): HoldingFidelity {
  if (movements.some((movement) => movementLinksToHolding(movement, holding))) {
    return "movements";
  }
  return holding.declaredCost !== undefined ? "declared_cost" : "value_only";
}

/**
 * The positions + movements document (PRD #1103 S4): a portfolio's holdings with
 * their current value, plus optional dated movements. Movements may be empty (a
 * pure snapshot). Each holding carries its derived fidelity tier.
 */
export const positionsMovementsDocumentSchema = z
  .object({
    documentType: z.literal("positions_movements"),
    holdings: z
      .array(extractedHoldingSchema)
      .min(1)
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows),
    movements: z
      .array(extractedMovementSchema)
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows),
    uncertain: z.boolean().optional(),
    warnings: z
      .array(nonEmptyStringSchema)
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxWarnings),
  })
  .strict();

/** What a broker transactions row can be: the ledger prints trades, nothing else. */
export const TRANSACTION_KINDS = ["buy", "sell"] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** A positive magnitude with no sign, no separators and no exponent. */
const CANONICAL_DECIMAL = /^\d+(?:\.\d+)?$/;

/**
 * A decimal rendered in plain notation, through the domain's own seam (big.js, whose
 * exponent thresholds this app sets wide for exactly this). An unreadable value comes
 * back untouched so the schema below refuses it, rather than being turned into `NaN`.
 */
function plainDecimal(value: string): string {
  try {
    return normalizeDecimal(value);
  } catch {
    return value;
  }
}

/**
 * A magnitude carried as a DECIMAL STRING and not as a JSON number (#1487).
 *
 * Two reasons, and the second is the load-bearing one. A trade's units may carry eight
 * decimals (crypto) or six (participaciones) and its destination — the statement
 * contract's `DecimalString` — is a string all the way to the write, so a round trip
 * through a float is a precision loss with nothing to gain. And the vision lane must ask
 * for every printed figure as text anyway: asked for a number, the pool pads zeros until
 * it hits the token ceiling (#1316).
 *
 * A JSON number is still ACCEPTED and stringified, because a preview already sitting in
 * a client history must keep revalidating, and because a model that answers `3` instead
 * of `"3"` has said the right thing.
 *
 * Every conversion goes through {@link plainDecimal}, and a string that is ALREADY
 * canonical is left untouched: `String(0.00000001)` is `"1e-8"`, which this pattern
 * rightly refuses, so normalizing an exact reading «just in case» would be the one way
 * this schema could destroy the precision it exists to protect.
 */
const positiveDecimalStringSchema = z.preprocess(
  (value) => {
    if (typeof value === "number") {
      return Number.isFinite(value) ? plainDecimal(String(value)) : value;
    }
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (CANONICAL_DECIMAL.test(trimmed)) return trimmed;
    const normalized = normalizeExtractedNumber(trimmed);
    return normalized === null ? value : plainDecimal(String(normalized));
  },
  z
    .string()
    .trim()
    .regex(CANONICAL_DECIMAL, "Debe ser un número positivo.")
    .refine((value) => Number(value) > 0, "Debe ser mayor que cero."),
);

/**
 * ONE executed trade read off a broker's transactions export (#1487).
 *
 * It is deliberately NOT {@link extractedMovementSchema}: a movement of a portfolio
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

export type ExtractedPosition = z.infer<typeof extractedPositionSchema>;
export type DatedBalance = z.infer<typeof datedBalanceSchema>;
export type ExtractedPositionsDocument = z.infer<typeof positionsDocumentSchema>;
export type ExtractedBalanceSeriesDocument = z.infer<typeof balanceSeriesDocumentSchema>;
export type ExtractedPositionsMovementsDocument = z.infer<
  typeof positionsMovementsDocumentSchema
>;
export type ExtractedBrokerTransactionsDocument = z.infer<
  typeof brokerTransactionsDocumentSchema
>;
export type ExtractedHoldingEventDocument = z.infer<typeof holdingEventDocumentSchema>;
/** The ONE observed fact a holding-event document carries (#1244, #1316). */
export type ExtractedHoldingEvent = ExtractedHoldingEventDocument["event"];
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

/**
 * The length ONE warning may reach — the bound `nonEmptyStringSchema` enforces, named
 * here because {@link capExtractionWarnings} is what keeps callers inside it.
 */
const MAX_WARNING_CHARS = 300;

/**
 * Fit a reading's honesty text inside the envelope's warning bounds, in BOTH
 * directions. A messy sheet can drop more rows than the contract admits warnings, so
 * the last slot summarizes the overflow instead of losing it silently; and a warning
 * that quotes an untrusted cell can outgrow the per-warning cap, which would fail the
 * branded parse and turn the whole reading into `invalid_output` — strictly worse than
 * `unrecognized`, because only `unrecognized` keeps the unstructured lane (#865) that
 * lets the model still discuss the file. Clamping is the honest failure: the reading
 * survives and the warning says a little less.
 *
 * Shared by every deterministic extractor: both caps belong to the contract that
 * declares them, not to one reader.
 */
export function capExtractionWarnings(warnings: readonly string[]): string[] {
  const max = ATTACHMENT_EXTRACTION_LIMITS_V1.maxWarnings;
  const clamped = warnings.map((warning) =>
    warning.length > MAX_WARNING_CHARS
      ? `${warning.slice(0, MAX_WARNING_CHARS - 1)}…`
      : warning,
  );
  if (clamped.length <= max) return clamped;
  const kept = clamped.slice(0, max - 1);
  kept.push(`y ${clamped.length - (max - 1)} avisos más sin mostrar.`);
  return kept;
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
