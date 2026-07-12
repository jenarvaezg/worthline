import type {
  AmortizationPlanInput,
  BalanceRebaselineInput,
  CreateLiabilityInput,
  DebtModel,
  DecimalString,
  EarlyRepayment,
  EarlyRepaymentMode,
  InterestRateRevision,
  Liability,
  OwnershipShare,
  ValuationCadence,
} from "@worthline/domain";
import {
  assertEventWithinTerm,
  createLiability,
  debtBalanceAtDate,
  defaultInstrumentForLiability,
  deriveCurrentStateAmortizationPlan,
} from "@worthline/domain";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";

import {
  ensureAgentViewPublicIds,
  publicIdTargetsForHolding,
} from "./agent-view-public-ids";
import {
  amortizationPlans,
  earlyRepayments,
  interestRateRevisions,
  liabilities,
  liabilityBalanceAnchors,
  liabilityBalanceRebaselines,
  liabilityOwnerships,
} from "./schema";
import {
  hardDeleteLiabilityTx,
  readLiabilities,
  type StoreContext,
} from "./store-context";

/** Fields that can be changed when editing an existing liability. */
export interface UpdateLiabilityInput {
  name?: string;
  type?: "mortgage" | "debt";
  associatedAssetId?: string | null;
  ownership?: OwnershipShare[];
}

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

/** Input for a single interest-rate revision (PRD #109, slice 7). */
export interface AddInterestRateRevisionInput {
  id: string;
  planId: string;
  /** YYYY-MM-DD the new rate takes effect from. */
  revisionDate: string;
  /** Decimal-string annual rate, e.g. "0.03". */
  newAnnualInterestRate: DecimalString;
}

/** A stored interest-rate revision as read back from the store. */
export interface InterestRateRevisionRecord extends InterestRateRevision {
  id: string;
  planId: string;
}

/** Fields that can be patched on an existing interest-rate revision. */
export interface UpdateInterestRateRevisionInput {
  revisionDate?: string;
  newAnnualInterestRate?: DecimalString;
}

/**
 * Result of an in-place interest-rate-revision write (ADR 0025). `changes` is the
 * 0/1 not-found contract; on a hit, `revisionDate`/`liabilityId` carry the OLD date
 * and owning liability the write read by id (resolving `planId → liability`) inside
 * the transaction, so the seam derives the ripple from-date without the caller
 * re-reading the row.
 */
export interface InterestRateRevisionWriteResult {
  changes: number;
  revisionDate?: string;
  /** Resolved `planId → liability`; `undefined` only if the plan row is gone. */
  liabilityId?: string | undefined;
}

/** Input for a single early repayment (PRD #146, slice S4). */
export interface AddEarlyRepaymentInput {
  id: string;
  planId: string;
  /** YYYY-MM-DD the repayment is made. */
  repaymentDate: string;
  /** Principal repaid, integer minor units. */
  amountMinor: number;
  /** reduce-payment keeps the term; reduce-term keeps the cuota. */
  mode: EarlyRepaymentMode;
}

/** A stored early repayment as read back from the store. */
export interface EarlyRepaymentRecord extends EarlyRepayment {
  id: string;
  planId: string;
}

/** Fields that can be patched on an existing early repayment. */
export interface UpdateEarlyRepaymentInput {
  repaymentDate?: string;
  amountMinor?: number;
  mode?: EarlyRepaymentMode;
}

/**
 * Result of an in-place early-repayment write (ADR 0025). `changes` is the 0/1
 * not-found contract; on a hit, `repaymentDate`/`liabilityId` carry the OLD date
 * and owning liability the write read by id (resolving `planId → liability`) inside
 * the transaction, so the seam derives the ripple from-date without the caller
 * re-reading the row.
 */
export interface EarlyRepaymentWriteResult {
  changes: number;
  repaymentDate?: string;
  /** Resolved `planId → liability`; `undefined` only if the plan row is gone. */
  liabilityId?: string | undefined;
}

export type BalanceRebaselineInputMode = "annual-rate" | "monthly-payment";

/** Input for a current-state balance re-baseline on an amortizable liability. */
export interface AddBalanceRebaselineInput {
  id: string;
  liabilityId: string;
  baselineDate: string;
  outstandingBalanceMinor: number;
  endDate: string;
  nextPaymentDate: string;
  annualInterestRate?: DecimalString;
  monthlyPaymentMinor?: number;
  startsAtBaseline?: boolean;
  source?: "manual" | "agent";
}

/** A stored current-state balance re-baseline as read back from the store. */
export interface BalanceRebaselineRecord extends BalanceRebaselineInput {
  id: string;
  liabilityId: string;
  monthlyPaymentMinor: number;
  inputMode: BalanceRebaselineInputMode;
  startsAtBaseline: boolean;
  source: "manual" | "agent";
}

/** Fields that can be patched on an existing balance re-baseline. */
export interface UpdateBalanceRebaselineInput {
  baselineDate?: string;
  outstandingBalanceMinor?: number;
  endDate?: string;
  nextPaymentDate?: string;
  annualInterestRate?: DecimalString;
  monthlyPaymentMinor?: number;
  startsAtBaseline?: boolean;
}

/** Result of an in-place balance-rebaseline write (ADR 0025 pattern). */
export interface BalanceRebaselineWriteResult {
  changes: number;
  baselineDate?: string;
  liabilityId?: string;
}

/** Input for a single balance anchor of a revolving/informal liability (slice 8). */
export interface AddBalanceAnchorInput {
  id: string;
  liabilityId: string;
  /** Total owed on that date, integer minor units (interest already included). */
  balanceMinor: number;
  /** YYYY-MM-DD the balance applies on. */
  anchorDate: string;
}

/** A stored balance anchor as read back from the store. */
export interface BalanceAnchorRecord {
  id: string;
  liabilityId: string;
  balanceMinor: number;
  anchorDate: string;
}

/** Fields that can be patched on an existing balance anchor. */
export interface UpdateBalanceAnchorInput {
  balanceMinor?: number;
  anchorDate?: string;
}

/**
 * Result of an in-place balance-anchor write (ADR 0025). `changes` is the 0/1
 * not-found contract; on a hit, `anchorDate`/`liabilityId` carry the OLD date and
 * owning liability the write read by id inside the transaction, so the seam can
 * derive the ripple from-date without the caller re-reading the row.
 */
export interface BalanceAnchorWriteResult {
  changes: number;
  anchorDate?: string;
  liabilityId?: string;
}

/**
 * Liability persistence (Slice R3 of the architectural refactor, PRD #120 / #123).
 * Owns the live liability rows, their ownership, the balance valuation, and the
 * trash (soft delete / restore / hard delete). Reads return domain Liabilities;
 * see readLiabilities.
 */
export interface LiabilityStore {
  createLiability: (input: CreateLiabilityInput) => Promise<void>;
  readLiabilities: () => Promise<Liability[]>;
  updateLiability: (liabilityId: string, input: UpdateLiabilityInput) => Promise<void>;
  updateLiabilityBalance: (liabilityId: string, balanceMinor: number) => Promise<void>;
  /** Soft-delete a liability (moves it to the trash). Returns 1 if moved, 0 if not found. */
  softDeleteLiability: (liabilityId: string, deletedAt: string) => Promise<number>;
  /** Restore a trashed liability. Returns 1 if restored, 0 if not found or not in trash. */
  restoreLiability: (liabilityId: string) => Promise<number>;
  /** Hard-delete a trashed liability (live data + overrides; snapshots untouched). Returns 1 if removed, 0 if not found or not in trash. */
  hardDeleteLiability: (liabilityId: string) => Promise<number>;
  /** Set (or clear, with null) a liability's debt model. */
  setDebtModel: (liabilityId: string, debtModel: DebtModel | null) => Promise<void>;
  /** Read a liability's debt model, or null if unset. */
  readDebtModel: (liabilityId: string) => Promise<DebtModel | null>;
  /** Set (or clear, with null) a liability's valuation cadence (ADR 0031). */
  setValuationCadence: (
    liabilityId: string,
    cadence: ValuationCadence | null,
  ) => Promise<void>;
  /** Read a liability's valuation cadence, or null (reads as `step`) if unset. */
  readValuationCadence: (liabilityId: string) => Promise<ValuationCadence | null>;
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
  /** Add an interest-rate revision to a plan. */
  addInterestRateRevision: (input: AddInterestRateRevisionInput) => Promise<void>;
  /** Read a plan's rate revisions, ordered ascending by date. */
  readInterestRateRevisions: (planId: string) => Promise<InterestRateRevisionRecord[]>;
  /**
   * Update a rate revision in place. `changes` is 1 if updated, 0 if not found; on
   * a hit it also returns the OLD date + owning liability read by id (ADR 0025).
   */
  updateInterestRateRevision: (
    revisionId: string,
    input: UpdateInterestRateRevisionInput,
  ) => Promise<InterestRateRevisionWriteResult>;
  /**
   * Delete a rate revision by id. `changes` is 1 if removed, 0 if not found; on a
   * hit it also returns the removed date + owning liability read by id (ADR 0025).
   */
  deleteInterestRateRevision: (
    revisionId: string,
  ) => Promise<InterestRateRevisionWriteResult>;
  /** Add an early repayment to a plan. */
  addEarlyRepayment: (input: AddEarlyRepaymentInput) => Promise<void>;
  /** Read a plan's early repayments, ordered ascending by date. */
  readEarlyRepayments: (planId: string) => Promise<EarlyRepaymentRecord[]>;
  /**
   * Update an early repayment in place. `changes` is 1 if updated, 0 if not found;
   * on a hit it also returns the OLD date + owning liability read by id (ADR 0025).
   */
  updateEarlyRepayment: (
    repaymentId: string,
    input: UpdateEarlyRepaymentInput,
  ) => Promise<EarlyRepaymentWriteResult>;
  /**
   * Delete an early repayment by id. `changes` is 1 if removed, 0 if not found; on
   * a hit it also returns the removed date + owning liability read by id (ADR 0025).
   */
  deleteEarlyRepayment: (repaymentId: string) => Promise<EarlyRepaymentWriteResult>;
  /** Add a current-state balance re-baseline to an amortizable liability. */
  addBalanceRebaseline: (input: AddBalanceRebaselineInput) => Promise<void>;
  /** Read a liability's balance re-baselines, ordered ascending by baseline date. */
  readBalanceRebaselines: (liabilityId: string) => Promise<BalanceRebaselineRecord[]>;
  /** Update a balance re-baseline in place. */
  updateBalanceRebaseline: (
    rebaselineId: string,
    input: UpdateBalanceRebaselineInput,
  ) => Promise<BalanceRebaselineWriteResult>;
  /** Delete a balance re-baseline by id. */
  deleteBalanceRebaseline: (
    rebaselineId: string,
  ) => Promise<BalanceRebaselineWriteResult>;
  /**
   * Outstanding principal of an amortizable liability on `targetDate`
   * (YYYY-MM-DD): reads the plan + revisions + early repayments and delegates to
   * the pure domain curve. Throws if the liability has no amortization plan.
   */
  amortizableBalanceAtDate: (liabilityId: string, targetDate: string) => Promise<number>;
  /** Add a balance anchor to a revolving/informal liability. */
  addBalanceAnchor: (input: AddBalanceAnchorInput) => Promise<void>;
  /** Read a liability's balance anchors, ordered ascending by date. */
  readBalanceAnchors: (liabilityId: string) => Promise<BalanceAnchorRecord[]>;
  /**
   * Update a balance anchor in place. `changes` is 1 if updated, 0 if not found;
   * on a hit it also returns the OLD date + owning liability read by id (ADR 0025).
   */
  updateBalanceAnchor: (
    anchorId: string,
    input: UpdateBalanceAnchorInput,
  ) => Promise<BalanceAnchorWriteResult>;
  /**
   * Delete a balance anchor by id. `changes` is 1 if removed, 0 if not found; on a
   * hit it also returns the removed date + owning liability read by id (ADR 0025).
   */
  deleteBalanceAnchor: (anchorId: string) => Promise<BalanceAnchorWriteResult>;
  /**
   * Outstanding balance of a liability on `targetDate` (YYYY-MM-DD) for any debt
   * model: reads the model + anchors (+ plan/revisions when amortizable) + the
   * current balance and delegates to the pure domain dispatcher. A null model or
   * missing data falls back to the current balance.
   */
  debtBalanceAtDate: (liabilityId: string, targetDate: string) => Promise<number>;
}

export function createLiabilityStore(ctx: StoreContext): LiabilityStore {
  return {
    createLiability: (input) => createLiabilityRecord(ctx, input),
    readLiabilities: async () => readLiabilities(ctx.db, await ctx.getWorkspace()),
    updateLiability: (liabilityId, input) => updateLiability(ctx, liabilityId, input),
    updateLiabilityBalance: (liabilityId, balanceMinor) =>
      updateLiabilityBalance(ctx, liabilityId, balanceMinor),
    softDeleteLiability: (liabilityId, deletedAt) =>
      softDeleteLiability(ctx, liabilityId, deletedAt),
    restoreLiability: (liabilityId) => restoreLiability(ctx, liabilityId),
    hardDeleteLiability: (liabilityId) =>
      ctx.transaction(async () => hardDeleteLiabilityTx(ctx, liabilityId)),
    setDebtModel: (liabilityId, debtModel) => setDebtModel(ctx, liabilityId, debtModel),
    readDebtModel: (liabilityId) => readDebtModel(ctx, liabilityId),
    setValuationCadence: (liabilityId, cadence) =>
      setValuationCadence(ctx, liabilityId, cadence),
    readValuationCadence: (liabilityId) => readValuationCadence(ctx, liabilityId),
    createAmortizationPlan: (input) => createAmortizationPlan(ctx, input),
    readAmortizationPlan: (liabilityId) => readAmortizationPlan(ctx, liabilityId),
    updateAmortizationPlan: (planId, input) => updateAmortizationPlan(ctx, planId, input),
    deleteAmortizationPlan: (planId) => deleteAmortizationPlan(ctx, planId),
    addInterestRateRevision: (input) => addInterestRateRevision(ctx, input),
    readInterestRateRevisions: (planId) => readInterestRateRevisions(ctx, planId),
    updateInterestRateRevision: (revisionId, input) =>
      updateInterestRateRevision(ctx, revisionId, input),
    deleteInterestRateRevision: (revisionId) =>
      deleteInterestRateRevision(ctx, revisionId),
    addEarlyRepayment: (input) => addEarlyRepayment(ctx, input),
    readEarlyRepayments: (planId) => readEarlyRepayments(ctx, planId),
    updateEarlyRepayment: (repaymentId, input) =>
      updateEarlyRepayment(ctx, repaymentId, input),
    deleteEarlyRepayment: (repaymentId) => deleteEarlyRepayment(ctx, repaymentId),
    addBalanceRebaseline: (input) => addBalanceRebaseline(ctx, input),
    readBalanceRebaselines: (liabilityId) => readBalanceRebaselines(ctx, liabilityId),
    updateBalanceRebaseline: (rebaselineId, input) =>
      updateBalanceRebaseline(ctx, rebaselineId, input),
    deleteBalanceRebaseline: (rebaselineId) => deleteBalanceRebaseline(ctx, rebaselineId),
    amortizableBalanceAtDate: (liabilityId, targetDate) =>
      amortizableBalanceAtDateFor(ctx, liabilityId, targetDate),
    addBalanceAnchor: (input) => addBalanceAnchor(ctx, input),
    readBalanceAnchors: (liabilityId) => readBalanceAnchors(ctx, liabilityId),
    updateBalanceAnchor: (anchorId, input) => updateBalanceAnchor(ctx, anchorId, input),
    deleteBalanceAnchor: (anchorId) => deleteBalanceAnchor(ctx, anchorId),
    debtBalanceAtDate: (liabilityId, targetDate) =>
      debtBalanceAtDateFor(ctx, liabilityId, targetDate),
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

function assertIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) {
    throw new Error(`${label} must be in YYYY-MM-DD format, got "${value}".`);
  }
}

function assertDecimalString(value: string, label: string): void {
  if (!DECIMAL_STRING.test(value)) {
    throw new Error(`${label} must be a decimal string (e.g. "0.025"), got "${value}".`);
  }
}

async function setDebtModel(
  ctx: StoreContext,
  liabilityId: string,
  debtModel: DebtModel | null,
): Promise<void> {
  await ctx.db
    .update(liabilities)
    .set({ debtModel, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(liabilities.id, liabilityId))
    .run();
  await ctx.writeAuditEntry("set_debt_model", "liability", liabilityId, { debtModel });
}

async function readDebtModel(
  ctx: StoreContext,
  liabilityId: string,
): Promise<DebtModel | null> {
  const row = await ctx.db
    .select({ debtModel: liabilities.debtModel })
    .from(liabilities)
    .where(eq(liabilities.id, liabilityId))
    .get();
  return row?.debtModel ?? null;
}

async function setValuationCadence(
  ctx: StoreContext,
  liabilityId: string,
  cadence: ValuationCadence | null,
): Promise<void> {
  await ctx.db
    .update(liabilities)
    .set({ valuationCadence: cadence, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(liabilities.id, liabilityId))
    .run();
  await ctx.writeAuditEntry("set_valuation_cadence", "liability", liabilityId, {
    cadence,
  });
}

async function readValuationCadence(
  ctx: StoreContext,
  liabilityId: string,
): Promise<ValuationCadence | null> {
  const row = await ctx.db
    .select({ valuationCadence: liabilities.valuationCadence })
    .from(liabilities)
    .where(eq(liabilities.id, liabilityId))
    .get();
  return row?.valuationCadence ?? null;
}

async function createAmortizationPlan(
  ctx: StoreContext,
  input: CreateAmortizationPlanInput,
): Promise<void> {
  if (!Number.isInteger(input.initialCapitalMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }
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

async function readAmortizationPlan(
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
async function readPlanInputById(
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
  if (
    input.initialCapitalMinor !== undefined &&
    !Number.isInteger(input.initialCapitalMinor)
  ) {
    throw new Error("Money must be stored as integer minor units.");
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

async function addInterestRateRevision(
  ctx: StoreContext,
  input: AddInterestRateRevisionInput,
): Promise<void> {
  assertIsoDate(input.revisionDate, "Revision date");
  assertDecimalString(input.newAnnualInterestRate, "Annual interest rate");

  // #210: an event past the loan's final payment boundary resolves outside the
  // term and would be silently dropped by the schedule build loop — reject it.
  const plan = await readPlanInputById(ctx, input.planId);
  if (plan) {
    assertEventWithinTerm(plan, input.revisionDate, "Revision date");
  }

  await ctx.db
    .insert(interestRateRevisions)
    .values({
      id: input.id,
      newAnnualInterestRate: input.newAnnualInterestRate,
      planId: input.planId,
      revisionDate: input.revisionDate,
    })
    .run();

  await ctx.writeAuditEntry("add_rate_revision", "amortization_plan", input.planId, {
    newAnnualInterestRate: input.newAnnualInterestRate,
    revisionDate: input.revisionDate,
    revisionId: input.id,
  });
}

async function readInterestRateRevisions(
  ctx: StoreContext,
  planId: string,
): Promise<InterestRateRevisionRecord[]> {
  const rows = await ctx.db
    .select()
    .from(interestRateRevisions)
    .where(eq(interestRateRevisions.planId, planId))
    .orderBy(asc(interestRateRevisions.revisionDate), asc(interestRateRevisions.id))
    .all();

  return rows.map((row) => ({
    id: row.id,
    newAnnualInterestRate: row.newAnnualInterestRate,
    planId: row.planId,
    revisionDate: row.revisionDate,
  }));
}

/** Resolve the owning liability of an amortization plan, or undefined if gone. */
async function readLiabilityIdForPlan(
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

async function updateInterestRateRevision(
  ctx: StoreContext,
  revisionId: string,
  input: UpdateInterestRateRevisionInput,
): Promise<InterestRateRevisionWriteResult> {
  if (input.revisionDate !== undefined) {
    assertIsoDate(input.revisionDate, "Revision date");
  }
  if (input.newAnnualInterestRate !== undefined) {
    assertDecimalString(input.newAnnualInterestRate, "Annual interest rate");
  }

  // Widened by-id select (ADR 0025): the OLD date and owning plan are read here,
  // inside the transaction, so the seam derives the ripple from-date itself without
  // the caller re-reading the row first.
  const existing = await ctx.db
    .select({
      planId: interestRateRevisions.planId,
      revisionDate: interestRateRevisions.revisionDate,
    })
    .from(interestRateRevisions)
    .where(eq(interestRateRevisions.id, revisionId))
    .get();

  if (!existing) return { changes: 0 };

  // #210: an edited date that lands past the loan's final boundary would be
  // silently dropped just like an out-of-range add — reject it the same way.
  if (input.revisionDate !== undefined) {
    const plan = await readPlanInputById(ctx, existing.planId);
    if (plan) assertEventWithinTerm(plan, input.revisionDate, "Revision date");
  }

  const fields: Partial<typeof interestRateRevisions.$inferInsert> = {};
  if (input.revisionDate !== undefined) fields.revisionDate = input.revisionDate;
  if (input.newAnnualInterestRate !== undefined) {
    fields.newAnnualInterestRate = input.newAnnualInterestRate;
  }

  const result = await ctx.db
    .update(interestRateRevisions)
    .set(fields)
    .where(eq(interestRateRevisions.id, revisionId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry(
      "update_rate_revision",
      "amortization_plan",
      existing.planId,
      {
        revisionId,
        ...input,
      },
    );
  }
  return {
    changes: result.rowsAffected,
    liabilityId: await readLiabilityIdForPlan(ctx, existing.planId),
    revisionDate: existing.revisionDate,
  };
}

async function deleteInterestRateRevision(
  ctx: StoreContext,
  revisionId: string,
): Promise<InterestRateRevisionWriteResult> {
  // Widened by-id select (ADR 0025): the row's date and owning plan are read inside
  // the transaction so the seam ripples from the removed revision's own date.
  const row = await ctx.db
    .select({
      planId: interestRateRevisions.planId,
      revisionDate: interestRateRevisions.revisionDate,
    })
    .from(interestRateRevisions)
    .where(eq(interestRateRevisions.id, revisionId))
    .get();

  if (!row) return { changes: 0 };

  const liabilityId = await readLiabilityIdForPlan(ctx, row.planId);

  const result = await ctx.db
    .delete(interestRateRevisions)
    .where(eq(interestRateRevisions.id, revisionId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("delete_rate_revision", "amortization_plan", row.planId, {
      revisionId,
    });
  }
  return {
    changes: result.rowsAffected,
    liabilityId,
    revisionDate: row.revisionDate,
  };
}

async function addEarlyRepayment(
  ctx: StoreContext,
  input: AddEarlyRepaymentInput,
): Promise<void> {
  assertIsoDate(input.repaymentDate, "Repayment date");
  if (!Number.isInteger(input.amountMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }

  // #210: an event past the loan's final payment boundary resolves outside the
  // term and would be silently dropped by the schedule build loop — reject it.
  const plan = await readPlanInputById(ctx, input.planId);
  if (plan) {
    assertEventWithinTerm(plan, input.repaymentDate, "Repayment date");
  }

  await ctx.db
    .insert(earlyRepayments)
    .values({
      amountMinor: input.amountMinor,
      id: input.id,
      mode: input.mode,
      planId: input.planId,
      repaymentDate: input.repaymentDate,
    })
    .run();

  await ctx.writeAuditEntry("add_early_repayment", "amortization_plan", input.planId, {
    amountMinor: input.amountMinor,
    mode: input.mode,
    repaymentDate: input.repaymentDate,
    repaymentId: input.id,
  });
}

async function readEarlyRepayments(
  ctx: StoreContext,
  planId: string,
): Promise<EarlyRepaymentRecord[]> {
  const rows = await ctx.db
    .select()
    .from(earlyRepayments)
    .where(eq(earlyRepayments.planId, planId))
    .orderBy(asc(earlyRepayments.repaymentDate), asc(earlyRepayments.id))
    .all();

  return rows.map((row) => ({
    amountMinor: row.amountMinor,
    id: row.id,
    mode: row.mode,
    planId: row.planId,
    repaymentDate: row.repaymentDate,
  }));
}

async function updateEarlyRepayment(
  ctx: StoreContext,
  repaymentId: string,
  input: UpdateEarlyRepaymentInput,
): Promise<EarlyRepaymentWriteResult> {
  if (input.repaymentDate !== undefined) {
    assertIsoDate(input.repaymentDate, "Repayment date");
  }
  if (input.amountMinor !== undefined && !Number.isInteger(input.amountMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }

  // Widened by-id select (ADR 0025): the OLD date and owning plan are read here,
  // inside the transaction, so the seam derives the ripple from-date itself without
  // the caller re-reading the row first.
  const existing = await ctx.db
    .select({
      planId: earlyRepayments.planId,
      repaymentDate: earlyRepayments.repaymentDate,
    })
    .from(earlyRepayments)
    .where(eq(earlyRepayments.id, repaymentId))
    .get();

  if (!existing) return { changes: 0 };

  // #210: an edited date that lands past the loan's final boundary would be
  // silently dropped just like an out-of-range add — reject it the same way.
  if (input.repaymentDate !== undefined) {
    const plan = await readPlanInputById(ctx, existing.planId);
    if (plan) assertEventWithinTerm(plan, input.repaymentDate, "Repayment date");
  }

  const fields: Partial<typeof earlyRepayments.$inferInsert> = {};
  if (input.repaymentDate !== undefined) fields.repaymentDate = input.repaymentDate;
  if (input.amountMinor !== undefined) fields.amountMinor = input.amountMinor;
  if (input.mode !== undefined) fields.mode = input.mode;

  const result = await ctx.db
    .update(earlyRepayments)
    .set(fields)
    .where(eq(earlyRepayments.id, repaymentId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry(
      "update_early_repayment",
      "amortization_plan",
      existing.planId,
      {
        repaymentId,
        ...input,
      },
    );
  }
  return {
    changes: result.rowsAffected,
    liabilityId: await readLiabilityIdForPlan(ctx, existing.planId),
    repaymentDate: existing.repaymentDate,
  };
}

async function deleteEarlyRepayment(
  ctx: StoreContext,
  repaymentId: string,
): Promise<EarlyRepaymentWriteResult> {
  // Widened by-id select (ADR 0025): the row's date and owning plan are read inside
  // the transaction so the seam ripples from the removed repayment's own date.
  const row = await ctx.db
    .select({
      planId: earlyRepayments.planId,
      repaymentDate: earlyRepayments.repaymentDate,
    })
    .from(earlyRepayments)
    .where(eq(earlyRepayments.id, repaymentId))
    .get();

  if (!row) return { changes: 0 };

  const liabilityId = await readLiabilityIdForPlan(ctx, row.planId);

  const result = await ctx.db
    .delete(earlyRepayments)
    .where(eq(earlyRepayments.id, repaymentId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("delete_early_repayment", "amortization_plan", row.planId, {
      repaymentId,
    });
  }
  return {
    changes: result.rowsAffected,
    liabilityId,
    repaymentDate: row.repaymentDate,
  };
}

function deriveRebaselineStorage(input: {
  baselineDate: string;
  outstandingBalanceMinor: number;
  endDate: string;
  nextPaymentDate: string;
  annualInterestRate?: DecimalString;
  monthlyPaymentMinor?: number;
}): {
  annualInterestRate: DecimalString;
  monthlyPaymentMinor: number;
  inputMode: BalanceRebaselineInputMode;
} {
  const hasRate = input.annualInterestRate !== undefined;
  const hasPayment = input.monthlyPaymentMinor !== undefined;
  if (hasRate === hasPayment) {
    throw new Error("Provide exactly one of annualInterestRate or monthlyPaymentMinor.");
  }

  const derived = deriveCurrentStateAmortizationPlan({
    baselineDate: input.baselineDate,
    endDate: input.endDate,
    nextPaymentDate: input.nextPaymentDate,
    outstandingBalanceMinor: input.outstandingBalanceMinor,
    ...(input.annualInterestRate !== undefined
      ? { annualInterestRate: input.annualInterestRate }
      : {}),
    ...(input.monthlyPaymentMinor !== undefined
      ? { monthlyPaymentMinor: input.monthlyPaymentMinor }
      : {}),
  });

  return {
    annualInterestRate: derived.annualInterestRate,
    inputMode: hasPayment ? "monthly-payment" : "annual-rate",
    monthlyPaymentMinor: derived.monthlyPaymentMinor,
  };
}

async function addBalanceRebaseline(
  ctx: StoreContext,
  input: AddBalanceRebaselineInput,
): Promise<void> {
  const derived = deriveRebaselineStorage(input);

  await ctx.db
    .insert(liabilityBalanceRebaselines)
    .values({
      annualInterestRate: derived.annualInterestRate,
      baselineDate: input.baselineDate,
      endDate: input.endDate,
      id: input.id,
      inputMode: derived.inputMode,
      liabilityId: input.liabilityId,
      monthlyPaymentMinor: derived.monthlyPaymentMinor,
      nextPaymentDate: input.nextPaymentDate,
      outstandingBalanceMinor: input.outstandingBalanceMinor,
      startsAtBaseline: input.startsAtBaseline ?? false,
      source: input.source ?? "manual",
    })
    .run();

  await ctx.writeAuditEntry("add_balance_rebaseline", "liability", input.liabilityId, {
    baselineDate: input.baselineDate,
    rebaselineId: input.id,
  });
}

async function readBalanceRebaselines(
  ctx: StoreContext,
  liabilityId: string,
): Promise<BalanceRebaselineRecord[]> {
  const rows = await ctx.db
    .select()
    .from(liabilityBalanceRebaselines)
    .where(eq(liabilityBalanceRebaselines.liabilityId, liabilityId))
    .orderBy(
      asc(liabilityBalanceRebaselines.baselineDate),
      asc(liabilityBalanceRebaselines.id),
    )
    .all();

  return rows.map((row) => ({
    annualInterestRate: row.annualInterestRate,
    baselineDate: row.baselineDate,
    endDate: row.endDate,
    id: row.id,
    inputMode: row.inputMode,
    liabilityId: row.liabilityId,
    monthlyPaymentMinor: row.monthlyPaymentMinor,
    nextPaymentDate: row.nextPaymentDate,
    outstandingBalanceMinor: row.outstandingBalanceMinor,
    startsAtBaseline: row.startsAtBaseline,
    source: row.source,
  }));
}

async function updateBalanceRebaseline(
  ctx: StoreContext,
  rebaselineId: string,
  input: UpdateBalanceRebaselineInput,
): Promise<BalanceRebaselineWriteResult> {
  const existing = await ctx.db
    .select()
    .from(liabilityBalanceRebaselines)
    .where(eq(liabilityBalanceRebaselines.id, rebaselineId))
    .get();

  if (!existing) return { changes: 0 };

  const source =
    input.annualInterestRate !== undefined || input.monthlyPaymentMinor !== undefined
      ? {
          ...(input.annualInterestRate !== undefined
            ? { annualInterestRate: input.annualInterestRate }
            : {}),
          ...(input.monthlyPaymentMinor !== undefined
            ? { monthlyPaymentMinor: input.monthlyPaymentMinor }
            : {}),
        }
      : existing.inputMode === "annual-rate"
        ? { annualInterestRate: existing.annualInterestRate }
        : { monthlyPaymentMinor: existing.monthlyPaymentMinor };

  const derived = deriveRebaselineStorage({
    baselineDate: input.baselineDate ?? existing.baselineDate,
    endDate: input.endDate ?? existing.endDate,
    nextPaymentDate: input.nextPaymentDate ?? existing.nextPaymentDate,
    outstandingBalanceMinor:
      input.outstandingBalanceMinor ?? existing.outstandingBalanceMinor,
    ...source,
  });

  const result = await ctx.db
    .update(liabilityBalanceRebaselines)
    .set({
      annualInterestRate: derived.annualInterestRate,
      baselineDate: input.baselineDate ?? existing.baselineDate,
      endDate: input.endDate ?? existing.endDate,
      inputMode: derived.inputMode,
      monthlyPaymentMinor: derived.monthlyPaymentMinor,
      nextPaymentDate: input.nextPaymentDate ?? existing.nextPaymentDate,
      outstandingBalanceMinor:
        input.outstandingBalanceMinor ?? existing.outstandingBalanceMinor,
      startsAtBaseline: input.startsAtBaseline ?? existing.startsAtBaseline,
    })
    .where(eq(liabilityBalanceRebaselines.id, rebaselineId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry(
      "update_balance_rebaseline",
      "liability",
      existing.liabilityId,
      {
        rebaselineId,
        ...input,
      },
    );
  }

  return {
    baselineDate: existing.baselineDate,
    changes: result.rowsAffected,
    liabilityId: existing.liabilityId,
  };
}

async function deleteBalanceRebaseline(
  ctx: StoreContext,
  rebaselineId: string,
): Promise<BalanceRebaselineWriteResult> {
  const row = await ctx.db
    .select({
      baselineDate: liabilityBalanceRebaselines.baselineDate,
      liabilityId: liabilityBalanceRebaselines.liabilityId,
    })
    .from(liabilityBalanceRebaselines)
    .where(eq(liabilityBalanceRebaselines.id, rebaselineId))
    .get();

  if (!row) return { changes: 0 };

  const result = await ctx.db
    .delete(liabilityBalanceRebaselines)
    .where(eq(liabilityBalanceRebaselines.id, rebaselineId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("delete_balance_rebaseline", "liability", row.liabilityId, {
      rebaselineId,
    });
  }
  return {
    baselineDate: row.baselineDate,
    changes: result.rowsAffected,
    liabilityId: row.liabilityId,
  };
}

async function amortizableBalanceAtDateFor(
  ctx: StoreContext,
  liabilityId: string,
  targetDate: string,
): Promise<number> {
  const plan = await readAmortizationPlan(ctx, liabilityId);
  const rebaselines = await readBalanceRebaselines(ctx, liabilityId);
  if (!plan && rebaselines.length === 0) {
    throw new Error(`Liability "${liabilityId}" has no amortization plan.`);
  }

  const revisions = plan
    ? (await readInterestRateRevisions(ctx, plan.id)).map((revision) => ({
        newAnnualInterestRate: revision.newAnnualInterestRate,
        revisionDate: revision.revisionDate,
      }))
    : [];

  const repayments = plan
    ? (await readEarlyRepayments(ctx, plan.id)).map((repayment) => ({
        amountMinor: repayment.amountMinor,
        mode: repayment.mode,
        repaymentDate: repayment.repaymentDate,
      }))
    : [];

  return debtBalanceAtDate({
    balanceRebaselines: rebaselines,
    currentBalanceMinor: 0,
    debtModel: "amortizable",
    earlyRepayments: repayments,
    ...(plan
      ? {
          plan: {
            annualInterestRate: plan.annualInterestRate,
            disbursementDate: plan.disbursementDate,
            firstPaymentDate: plan.firstPaymentDate,
            initialCapitalMinor: plan.initialCapitalMinor,
            termMonths: plan.termMonths,
          },
        }
      : {}),
    revisions,
    targetDate,
  });
}

async function addBalanceAnchor(
  ctx: StoreContext,
  input: AddBalanceAnchorInput,
): Promise<void> {
  if (!Number.isInteger(input.balanceMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }
  assertIsoDate(input.anchorDate, "Anchor date");

  // The "liability must be revolving/informal" invariant is a domain/caller
  // guard (R9), not enforced here. The unique index on (liability_id,
  // anchor_date) keeps one anchor per liability per date — a collision throws.
  await ctx.db
    .insert(liabilityBalanceAnchors)
    .values({
      anchorDate: input.anchorDate,
      balanceMinor: input.balanceMinor,
      id: input.id,
      liabilityId: input.liabilityId,
    })
    .run();

  await ctx.writeAuditEntry("add_balance_anchor", "liability", input.liabilityId, {
    anchorDate: input.anchorDate,
    anchorId: input.id,
    balanceMinor: input.balanceMinor,
  });
}

async function readBalanceAnchors(
  ctx: StoreContext,
  liabilityId: string,
): Promise<BalanceAnchorRecord[]> {
  const rows = await ctx.db
    .select()
    .from(liabilityBalanceAnchors)
    .where(eq(liabilityBalanceAnchors.liabilityId, liabilityId))
    .orderBy(asc(liabilityBalanceAnchors.anchorDate), asc(liabilityBalanceAnchors.id))
    .all();

  return rows.map((row) => ({
    anchorDate: row.anchorDate,
    balanceMinor: row.balanceMinor,
    id: row.id,
    liabilityId: row.liabilityId,
  }));
}

async function updateBalanceAnchor(
  ctx: StoreContext,
  anchorId: string,
  input: UpdateBalanceAnchorInput,
): Promise<BalanceAnchorWriteResult> {
  if (input.balanceMinor !== undefined && !Number.isInteger(input.balanceMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }
  if (input.anchorDate !== undefined) {
    assertIsoDate(input.anchorDate, "Anchor date");
  }

  // Widened by-id select (ADR 0025): the OLD date and owning liability are read
  // here, inside the transaction, so the seam derives the ripple from-date itself
  // without the caller re-reading the row first.
  const existing = await ctx.db
    .select({
      anchorDate: liabilityBalanceAnchors.anchorDate,
      liabilityId: liabilityBalanceAnchors.liabilityId,
    })
    .from(liabilityBalanceAnchors)
    .where(eq(liabilityBalanceAnchors.id, anchorId))
    .get();

  if (!existing) return { changes: 0 };

  const fields: Partial<typeof liabilityBalanceAnchors.$inferInsert> = {};
  if (input.balanceMinor !== undefined) fields.balanceMinor = input.balanceMinor;
  if (input.anchorDate !== undefined) fields.anchorDate = input.anchorDate;

  const result = await ctx.db
    .update(liabilityBalanceAnchors)
    .set(fields)
    .where(eq(liabilityBalanceAnchors.id, anchorId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry(
      "update_balance_anchor",
      "liability",
      existing.liabilityId,
      {
        anchorId,
        ...input,
      },
    );
  }
  return {
    anchorDate: existing.anchorDate,
    changes: result.rowsAffected,
    liabilityId: existing.liabilityId,
  };
}

async function deleteBalanceAnchor(
  ctx: StoreContext,
  anchorId: string,
): Promise<BalanceAnchorWriteResult> {
  // Widened by-id select (ADR 0025): the row's date and owning liability are read
  // inside the transaction so the seam ripples from the removed anchor's own date.
  const row = await ctx.db
    .select({
      anchorDate: liabilityBalanceAnchors.anchorDate,
      liabilityId: liabilityBalanceAnchors.liabilityId,
    })
    .from(liabilityBalanceAnchors)
    .where(eq(liabilityBalanceAnchors.id, anchorId))
    .get();

  if (!row) return { changes: 0 };

  const result = await ctx.db
    .delete(liabilityBalanceAnchors)
    .where(eq(liabilityBalanceAnchors.id, anchorId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("delete_balance_anchor", "liability", row.liabilityId, {
      anchorId,
    });
  }
  return {
    anchorDate: row.anchorDate,
    changes: result.rowsAffected,
    liabilityId: row.liabilityId,
  };
}

async function debtBalanceAtDateFor(
  ctx: StoreContext,
  liabilityId: string,
  targetDate: string,
): Promise<number> {
  const row = await ctx.db
    .select({
      currentBalanceMinor: liabilities.currentBalanceMinor,
      debtModel: liabilities.debtModel,
      valuationCadence: liabilities.valuationCadence,
    })
    .from(liabilities)
    .where(eq(liabilities.id, liabilityId))
    .get();

  if (!row) {
    throw new Error(`Liability "${liabilityId}" not found.`);
  }

  const currentBalanceMinor = row.currentBalanceMinor;
  const debtModel = row.debtModel ?? null;
  // The stored cadence (ADR 0031, #393); null reads as `step` in the engine.
  const cadence = row.valuationCadence ?? null;

  if (debtModel === "amortizable") {
    const plan = await readAmortizationPlan(ctx, liabilityId);
    const rebaselines = await readBalanceRebaselines(ctx, liabilityId);
    if (!plan) {
      return debtBalanceAtDate({
        balanceRebaselines: rebaselines,
        currentBalanceMinor,
        debtModel,
        targetDate,
        ...(cadence != null ? { cadence } : {}),
      });
    }
    const revisions = (await readInterestRateRevisions(ctx, plan.id)).map((revision) => ({
      newAnnualInterestRate: revision.newAnnualInterestRate,
      revisionDate: revision.revisionDate,
    }));
    const repayments = (await readEarlyRepayments(ctx, plan.id)).map((repayment) => ({
      amountMinor: repayment.amountMinor,
      mode: repayment.mode,
      repaymentDate: repayment.repaymentDate,
    }));
    return debtBalanceAtDate({
      balanceRebaselines: rebaselines,
      currentBalanceMinor,
      debtModel,
      earlyRepayments: repayments,
      plan: {
        annualInterestRate: plan.annualInterestRate,
        disbursementDate: plan.disbursementDate,
        firstPaymentDate: plan.firstPaymentDate,
        initialCapitalMinor: plan.initialCapitalMinor,
        termMonths: plan.termMonths,
      },
      revisions,
      targetDate,
      ...(cadence != null ? { cadence } : {}),
    });
  }

  const anchors = (await readBalanceAnchors(ctx, liabilityId)).map((anchor) => ({
    anchorDate: anchor.anchorDate,
    balanceMinor: anchor.balanceMinor,
  }));

  return debtBalanceAtDate({
    anchors,
    currentBalanceMinor,
    debtModel,
    targetDate,
    ...(cadence != null ? { cadence } : {}),
  });
}

async function createLiabilityRecord(
  ctx: StoreContext,
  input: CreateLiabilityInput,
): Promise<void> {
  const { db } = ctx;
  const workspace = await ctx.getWorkspace();

  if (!workspace) {
    throw new Error("Workspace must be initialized before creating liabilities.");
  }

  // The split rule is enforced at the write boundary (createLiabilitySafe, which
  // allows a known partial for a debt on a co-owned home — #171). This low-level
  // persist only constructs the row, so it accepts ≤100% rather than re-asserting
  // strict 100% and rejecting an already-approved partial split.
  const liability = createLiability(workspace, input, { allowKnownPartial: true });
  await ctx.transaction(async () => {
    await db
      .insert(liabilities)
      .values({
        associatedAssetId: liability.associatedAssetId ?? null,
        currency: liability.currency,
        currentBalanceMinor: liability.currentBalance.amountMinor,
        id: liability.id,
        // Debt model is declared later (setDebtModel); at create time the
        // instrument follows the liability type (mortgage→mortgage, else loan).
        instrument: defaultInstrumentForLiability(liability.type, null),
        name: liability.name,
        type: liability.type,
      })
      .run();

    if (liability.ownership.length > 0) {
      await db
        .insert(liabilityOwnerships)
        .values(
          liability.ownership.map((share) => ({
            liabilityId: liability.id,
            memberId: share.memberId,
            shareBps: share.shareBps,
          })),
        )
        .run();
    }

    // Register the holding's agent-view public id on creation (#335) so the
    // non-lazy read path never 500s on a missing id — mirrors createMember.
    await ensureAgentViewPublicIds(ctx, publicIdTargetsForHolding(liability.id));
  });

  await ctx.writeAuditEntry("create_liability", "liability", liability.id);
}

async function updateLiability(
  ctx: StoreContext,
  liabilityId: string,
  input: UpdateLiabilityInput,
): Promise<void> {
  const { db } = ctx;
  const fields: Partial<typeof liabilities.$inferInsert> = {};

  if (input.name !== undefined) {
    fields.name = input.name;
  }

  if (input.type !== undefined) {
    fields.type = input.type;
  }

  if (input.associatedAssetId !== undefined) {
    fields.associatedAssetId = input.associatedAssetId;
  }

  await ctx.transaction(async () => {
    if (Object.keys(fields).length > 0) {
      await db
        .update(liabilities)
        .set({ ...fields, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(liabilities.id, liabilityId))
        .run();
    }

    if (input.ownership !== undefined) {
      await db
        .delete(liabilityOwnerships)
        .where(eq(liabilityOwnerships.liabilityId, liabilityId))
        .run();

      if (input.ownership.length > 0) {
        await db
          .insert(liabilityOwnerships)
          .values(
            input.ownership.map((share) => ({
              liabilityId,
              memberId: share.memberId,
              shareBps: share.shareBps,
            })),
          )
          .run();
      }
    }
  });

  await ctx.writeAuditEntry("update_liability", "liability", liabilityId, {
    ...input,
    ownership: undefined,
  });
}

async function updateLiabilityBalance(
  ctx: StoreContext,
  liabilityId: string,
  balanceMinor: number,
): Promise<void> {
  const { db } = ctx;

  if (!Number.isInteger(balanceMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }

  await db
    .update(liabilities)
    .set({ currentBalanceMinor: balanceMinor, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(liabilities.id, liabilityId))
    .run();
  await ctx.writeAuditEntry("update_balance", "liability", liabilityId, { balanceMinor });
}

async function softDeleteLiability(
  ctx: StoreContext,
  liabilityId: string,
  deletedAt: string,
): Promise<number> {
  const result = await ctx.db
    .update(liabilities)
    .set({ deletedAt })
    .where(eq(liabilities.id, liabilityId))
    .run();
  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("delete_liability", "liability", liabilityId, {
      deletedAt,
    });
  }
  return result.rowsAffected;
}

async function restoreLiability(ctx: StoreContext, liabilityId: string): Promise<number> {
  const result = await ctx.db
    .update(liabilities)
    .set({ deletedAt: null })
    .where(and(eq(liabilities.id, liabilityId), isNotNull(liabilities.deletedAt)))
    .run();
  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("restore_liability", "liability", liabilityId);
  }
  return result.rowsAffected;
}
