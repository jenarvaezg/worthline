import type { AmortizationPlanInput, DecimalString } from "@worthline/domain";
import { eq } from "drizzle-orm";
import {
  assertDecimalString,
  assertIsoDate,
  assertMinorUnits,
} from "./liability-fact-guards";
import { amortizationPlans } from "./schema";
import type { StoreContext } from "./store-context";

/** Input for an amortization plan (PRD #109, slice 7; two dates ADR 0019, #188). */
export interface CreateAmortizationPlanInput {
  id: string;
  liabilityId: string;
  /** Initial borrowed capital, integer minor units. */
  initialCapitalMinor: number;
  /** Decimal-string annual interest rate, e.g. "0.025". */
  annualInterestRate: DecimalString;
  /** Loan term in whole months (payments counted from the first payment). */
  termMonths: number;
  /** Disbursement date (firma / devengo), YYYY-MM-DD. */
  disbursementDate: string;
  /** First-payment date, YYYY-MM-DD (its day-of-month is the recurring pay day). */
  firstPaymentDate: string;
  /**
   * Optional descriptive metadata (ADR 0056, #677): the debt's true original
   * signing date, when it differs from `disbursementDate` (current-state entry).
   * Never read by the balance curve.
   */
  originalSigningDate?: string | null;
}

/** An amortization plan as read back from the store. */
export interface AmortizationPlanRecord {
  id: string;
  liabilityId: string;
  initialCapitalMinor: number;
  annualInterestRate: DecimalString;
  termMonths: number;
  disbursementDate: string;
  firstPaymentDate: string;
  originalSigningDate: string | null;
}

/** Fields that can be patched on an existing amortization plan. */
export interface UpdateAmortizationPlanInput {
  initialCapitalMinor?: number;
  annualInterestRate?: DecimalString;
  termMonths?: number;
  disbursementDate?: string;
  firstPaymentDate?: string;
  originalSigningDate?: string | null;
}

/**
 * The amortization plan of a liability: the contracted schedule itself (capital,
 * rate, term, the two dates of ADR 0019), 1:1 with the liability. Its dated
 * events — rate revisions and early repayments — are their own families and live
 * in their own modules (#1604); this one only owns the plan row.
 */
export interface AmortizationPlanStore {
  /** Create the amortization plan for a liability (1:1; throws if one exists). */
  createAmortizationPlan: (input: CreateAmortizationPlanInput) => Promise<void>;
  /** Read a liability's amortization plan, or null if it has none. */
  readAmortizationPlan: (liabilityId: string) => Promise<AmortizationPlanRecord | null>;
  /** Update an amortization plan in place. Returns 1 if updated, 0 if not found. */
  updateAmortizationPlan: (
    planId: string,
    input: UpdateAmortizationPlanInput,
  ) => Promise<number>;
  /** Delete an amortization plan by id (cascades its revisions). Returns 1 if removed, 0 if not found. */
  deleteAmortizationPlan: (planId: string) => Promise<number>;
}

export function createAmortizationPlanStore(ctx: StoreContext): AmortizationPlanStore {
  return {
    createAmortizationPlan: (input) => createAmortizationPlan(ctx, input),
    readAmortizationPlan: (liabilityId) => readAmortizationPlan(ctx, liabilityId),
    updateAmortizationPlan: (planId, input) => updateAmortizationPlan(ctx, planId, input),
    deleteAmortizationPlan: (planId) => deleteAmortizationPlan(ctx, planId),
  };
}

async function createAmortizationPlan(
  ctx: StoreContext,
  input: CreateAmortizationPlanInput,
): Promise<void> {
  assertMinorUnits(input.initialCapitalMinor);
  if (!Number.isInteger(input.termMonths) || input.termMonths <= 0) {
    throw new Error(
      `Term must be a positive whole number of months, got "${input.termMonths}".`,
    );
  }
  assertIsoDate(input.disbursementDate, "Disbursement date");
  assertIsoDate(input.firstPaymentDate, "First-payment date");
  if (input.disbursementDate > input.firstPaymentDate) {
    throw new Error(
      `Disbursement date must be ≤ first-payment date, got disbursement "${input.disbursementDate}" > first-payment "${input.firstPaymentDate}".`,
    );
  }
  assertDecimalString(input.annualInterestRate, "Annual interest rate");
  if (input.originalSigningDate) {
    assertIsoDate(input.originalSigningDate, "Original signing date");
  }

  // The "liability must be amortizable" invariant is a domain/caller guard (R9),
  // not enforced here. The unique index on liability_id keeps the plan 1:1.
  await ctx.db
    .insert(amortizationPlans)
    .values({
      annualInterestRate: input.annualInterestRate,
      disbursementDate: input.disbursementDate,
      firstPaymentDate: input.firstPaymentDate,
      id: input.id,
      initialCapitalMinor: input.initialCapitalMinor,
      liabilityId: input.liabilityId,
      originalSigningDate: input.originalSigningDate ?? null,
      termMonths: input.termMonths,
    })
    .run();

  await ctx.writeAuditEntry("create_amortization_plan", "liability", input.liabilityId, {
    planId: input.id,
  });
}

export async function readAmortizationPlan(
  ctx: StoreContext,
  liabilityId: string,
): Promise<AmortizationPlanRecord | null> {
  const row = await ctx.db
    .select()
    .from(amortizationPlans)
    .where(eq(amortizationPlans.liabilityId, liabilityId))
    .get();

  if (!row) return null;

  return {
    annualInterestRate: row.annualInterestRate,
    disbursementDate: row.disbursementDate,
    firstPaymentDate: row.firstPaymentDate,
    id: row.id,
    initialCapitalMinor: row.initialCapitalMinor,
    liabilityId: row.liabilityId,
    originalSigningDate: row.originalSigningDate ?? null,
    termMonths: row.termMonths,
  };
}

/**
 * The schedule shape of a plan, by plan id, as the pure domain engine reads it —
 * or null if the plan is gone. Used to pin a dated event's boundary so the intake
 * can reject events that fall past the loan's final payment (#210).
 */
export async function readPlanInputById(
  ctx: StoreContext,
  planId: string,
): Promise<AmortizationPlanInput | null> {
  const row = await ctx.db
    .select()
    .from(amortizationPlans)
    .where(eq(amortizationPlans.id, planId))
    .get();

  if (!row) return null;

  return {
    annualInterestRate: row.annualInterestRate,
    disbursementDate: row.disbursementDate,
    firstPaymentDate: row.firstPaymentDate,
    initialCapitalMinor: row.initialCapitalMinor,
    termMonths: row.termMonths,
  };
}

async function updateAmortizationPlan(
  ctx: StoreContext,
  planId: string,
  input: UpdateAmortizationPlanInput,
): Promise<number> {
  if (input.initialCapitalMinor !== undefined) {
    assertMinorUnits(input.initialCapitalMinor);
  }
  if (
    input.termMonths !== undefined &&
    (!Number.isInteger(input.termMonths) || input.termMonths <= 0)
  ) {
    throw new Error(
      `Term must be a positive whole number of months, got "${input.termMonths}".`,
    );
  }
  if (input.disbursementDate !== undefined) {
    assertIsoDate(input.disbursementDate, "Disbursement date");
  }
  if (input.firstPaymentDate !== undefined) {
    assertIsoDate(input.firstPaymentDate, "First-payment date");
  }
  if (input.annualInterestRate !== undefined) {
    assertDecimalString(input.annualInterestRate, "Annual interest rate");
  }
  if (input.originalSigningDate) {
    assertIsoDate(input.originalSigningDate, "Original signing date");
  }
  // Guard ordering when both dates are being updated together.
  if (
    input.disbursementDate !== undefined &&
    input.firstPaymentDate !== undefined &&
    input.disbursementDate > input.firstPaymentDate
  ) {
    throw new Error(
      `Disbursement date must be ≤ first-payment date, got disbursement "${input.disbursementDate}" > first-payment "${input.firstPaymentDate}".`,
    );
  }

  const existing = await ctx.db
    .select({ liabilityId: amortizationPlans.liabilityId })
    .from(amortizationPlans)
    .where(eq(amortizationPlans.id, planId))
    .get();

  if (!existing) return 0;

  const fields: Partial<typeof amortizationPlans.$inferInsert> = {};
  if (input.initialCapitalMinor !== undefined) {
    fields.initialCapitalMinor = input.initialCapitalMinor;
  }
  if (input.annualInterestRate !== undefined) {
    fields.annualInterestRate = input.annualInterestRate;
  }
  if (input.termMonths !== undefined) fields.termMonths = input.termMonths;
  if (input.disbursementDate !== undefined) {
    fields.disbursementDate = input.disbursementDate;
  }
  if (input.firstPaymentDate !== undefined) {
    fields.firstPaymentDate = input.firstPaymentDate;
  }
  if (input.originalSigningDate !== undefined) {
    fields.originalSigningDate = input.originalSigningDate;
  }

  const result = await ctx.db
    .update(amortizationPlans)
    .set(fields)
    .where(eq(amortizationPlans.id, planId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry(
      "update_amortization_plan",
      "liability",
      existing.liabilityId,
      {
        planId,
        ...input,
      },
    );
  }
  return result.rowsAffected;
}

async function deleteAmortizationPlan(
  ctx: StoreContext,
  planId: string,
): Promise<number> {
  const row = await ctx.db
    .select({ liabilityId: amortizationPlans.liabilityId })
    .from(amortizationPlans)
    .where(eq(amortizationPlans.id, planId))
    .get();

  if (!row) return 0;

  const result = await ctx.db
    .delete(amortizationPlans)
    .where(eq(amortizationPlans.id, planId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("delete_amortization_plan", "liability", row.liabilityId, {
      planId,
    });
  }
  return result.rowsAffected;
}

/** Resolve the owning liability of an amortization plan, or undefined if gone. */
export async function readLiabilityIdForPlan(
  ctx: StoreContext,
  planId: string,
): Promise<string | undefined> {
  const row = await ctx.db
    .select({ liabilityId: amortizationPlans.liabilityId })
    .from(amortizationPlans)
    .where(eq(amortizationPlans.id, planId))
    .get();
  return row?.liabilityId;
}
