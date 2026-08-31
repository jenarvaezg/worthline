import { z } from "zod";

import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  currencySchema,
  extractedNumberSchema,
  isinSchema,
  isoDateSchema,
  nonEmptyStringSchema,
} from "./attachment-extraction-primitives";

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

export type ExtractedPositionsMovementsDocument = z.infer<
  typeof positionsMovementsDocumentSchema
>;
