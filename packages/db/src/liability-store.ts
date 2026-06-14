import type {
  CreateLiabilityInput,
  DebtModel,
  DecimalString,
  EarlyRepayment,
  EarlyRepaymentMode,
  InterestRateRevision,
  Liability,
  OwnershipShare,
} from "@worthline/domain";
import {
  amortizableBalanceAtDate,
  createLiability,
  debtBalanceAtDate,
  defaultInstrumentForLiability,
} from "@worthline/domain";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";

import {
  amortizationPlans,
  earlyRepayments,
  interestRateRevisions,
  liabilities,
  liabilityBalanceAnchors,
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

/** Input for an amortization plan (PRD #109, slice 7). */
export interface CreateAmortizationPlanInput {
  id: string;
  liabilityId: string;
  /** Initial borrowed capital, integer minor units. */
  initialCapitalMinor: number;
  /** Decimal-string annual interest rate, e.g. "0.025". */
  annualInterestRate: DecimalString;
  /** Loan term in whole months. */
  termMonths: number;
  /** Loan start date, YYYY-MM-DD. */
  startDate: string;
}

/** An amortization plan as read back from the store. */
export interface AmortizationPlanRecord {
  id: string;
  liabilityId: string;
  initialCapitalMinor: number;
  annualInterestRate: DecimalString;
  termMonths: number;
  startDate: string;
}

/** Fields that can be patched on an existing amortization plan. */
export interface UpdateAmortizationPlanInput {
  initialCapitalMinor?: number;
  annualInterestRate?: DecimalString;
  termMonths?: number;
  startDate?: string;
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
 * Liability persistence (Slice R3 of the architectural refactor, PRD #120 / #123).
 * Owns the live liability rows, their ownership, the balance valuation, and the
 * trash (soft delete / restore / hard delete). Reads return domain Liabilities;
 * see readLiabilities.
 */
export interface LiabilityStore {
  createLiability: (input: CreateLiabilityInput) => void;
  readLiabilities: () => Liability[];
  updateLiability: (liabilityId: string, input: UpdateLiabilityInput) => void;
  updateLiabilityBalance: (liabilityId: string, balanceMinor: number) => void;
  /** Soft-delete a liability (moves it to the trash). Returns 1 if moved, 0 if not found. */
  softDeleteLiability: (liabilityId: string, deletedAt: string) => number;
  /** Restore a trashed liability. Returns 1 if restored, 0 if not found or not in trash. */
  restoreLiability: (liabilityId: string) => number;
  /** Hard-delete a trashed liability (live data + overrides; snapshots untouched). Returns 1 if removed, 0 if not found or not in trash. */
  hardDeleteLiability: (liabilityId: string) => number;
  /** Set (or clear, with null) a liability's debt model. */
  setDebtModel: (liabilityId: string, debtModel: DebtModel | null) => void;
  /** Read a liability's debt model, or null if unset. */
  readDebtModel: (liabilityId: string) => DebtModel | null;
  /** Create the amortization plan for a liability (1:1; throws if one exists). */
  createAmortizationPlan: (input: CreateAmortizationPlanInput) => void;
  /** Read a liability's amortization plan, or null if it has none. */
  readAmortizationPlan: (liabilityId: string) => AmortizationPlanRecord | null;
  /** Update an amortization plan in place. Returns 1 if updated, 0 if not found. */
  updateAmortizationPlan: (planId: string, input: UpdateAmortizationPlanInput) => number;
  /** Delete an amortization plan by id (cascades its revisions). Returns 1 if removed, 0 if not found. */
  deleteAmortizationPlan: (planId: string) => number;
  /** Add an interest-rate revision to a plan. */
  addInterestRateRevision: (input: AddInterestRateRevisionInput) => void;
  /** Read a plan's rate revisions, ordered ascending by date. */
  readInterestRateRevisions: (planId: string) => InterestRateRevisionRecord[];
  /** Update a rate revision in place. Returns 1 if updated, 0 if not found. */
  updateInterestRateRevision: (
    revisionId: string,
    input: UpdateInterestRateRevisionInput,
  ) => number;
  /** Delete a rate revision by id. Returns 1 if removed, 0 if not found. */
  deleteInterestRateRevision: (revisionId: string) => number;
  /** Add an early repayment to a plan. */
  addEarlyRepayment: (input: AddEarlyRepaymentInput) => void;
  /** Read a plan's early repayments, ordered ascending by date. */
  readEarlyRepayments: (planId: string) => EarlyRepaymentRecord[];
  /** Update an early repayment in place. Returns 1 if updated, 0 if not found. */
  updateEarlyRepayment: (repaymentId: string, input: UpdateEarlyRepaymentInput) => number;
  /** Delete an early repayment by id. Returns 1 if removed, 0 if not found. */
  deleteEarlyRepayment: (repaymentId: string) => number;
  /**
   * Outstanding principal of an amortizable liability on `targetDate`
   * (YYYY-MM-DD): reads the plan + revisions + early repayments and delegates to
   * the pure domain curve. Throws if the liability has no amortization plan.
   */
  amortizableBalanceAtDate: (liabilityId: string, targetDate: string) => number;
  /** Add a balance anchor to a revolving/informal liability. */
  addBalanceAnchor: (input: AddBalanceAnchorInput) => void;
  /** Read a liability's balance anchors, ordered ascending by date. */
  readBalanceAnchors: (liabilityId: string) => BalanceAnchorRecord[];
  /** Update a balance anchor in place. Returns 1 if updated, 0 if not found. */
  updateBalanceAnchor: (anchorId: string, input: UpdateBalanceAnchorInput) => number;
  /** Delete a balance anchor by id. Returns 1 if removed, 0 if not found. */
  deleteBalanceAnchor: (anchorId: string) => number;
  /**
   * Outstanding balance of a liability on `targetDate` (YYYY-MM-DD) for any debt
   * model: reads the model + anchors (+ plan/revisions when amortizable) + the
   * current balance and delegates to the pure domain dispatcher. A null model or
   * missing data falls back to the current balance.
   */
  debtBalanceAtDate: (liabilityId: string, targetDate: string) => number;
}

export function createLiabilityStore(ctx: StoreContext): LiabilityStore {
  return {
    createLiability: (input) => createLiabilityRecord(ctx, input),
    readLiabilities: () => readLiabilities(ctx.db, ctx.getWorkspace()),
    updateLiability: (liabilityId, input) => updateLiability(ctx, liabilityId, input),
    updateLiabilityBalance: (liabilityId, balanceMinor) =>
      updateLiabilityBalance(ctx, liabilityId, balanceMinor),
    softDeleteLiability: (liabilityId, deletedAt) =>
      softDeleteLiability(ctx, liabilityId, deletedAt),
    restoreLiability: (liabilityId) => restoreLiability(ctx, liabilityId),
    hardDeleteLiability: (liabilityId) =>
      ctx.sqlite.transaction(() => hardDeleteLiabilityTx(ctx, liabilityId))(),
    setDebtModel: (liabilityId, debtModel) => setDebtModel(ctx, liabilityId, debtModel),
    readDebtModel: (liabilityId) => readDebtModel(ctx, liabilityId),
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

function setDebtModel(
  ctx: StoreContext,
  liabilityId: string,
  debtModel: DebtModel | null,
): void {
  ctx.db
    .update(liabilities)
    .set({ debtModel, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(liabilities.id, liabilityId))
    .run();
  ctx.writeAuditEntry("set_debt_model", "liability", liabilityId, { debtModel });
}

function readDebtModel(ctx: StoreContext, liabilityId: string): DebtModel | null {
  const row = ctx.db
    .select({ debtModel: liabilities.debtModel })
    .from(liabilities)
    .where(eq(liabilities.id, liabilityId))
    .get();
  return row?.debtModel ?? null;
}

function createAmortizationPlan(
  ctx: StoreContext,
  input: CreateAmortizationPlanInput,
): void {
  if (!Number.isInteger(input.initialCapitalMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }
  if (!Number.isInteger(input.termMonths) || input.termMonths <= 0) {
    throw new Error(
      `Term must be a positive whole number of months, got "${input.termMonths}".`,
    );
  }
  assertIsoDate(input.startDate, "Start date");
  assertDecimalString(input.annualInterestRate, "Annual interest rate");

  // The "liability must be amortizable" invariant is a domain/caller guard (R9),
  // not enforced here. The unique index on liability_id keeps the plan 1:1.
  ctx.db
    .insert(amortizationPlans)
    .values({
      annualInterestRate: input.annualInterestRate,
      id: input.id,
      initialCapitalMinor: input.initialCapitalMinor,
      liabilityId: input.liabilityId,
      startDate: input.startDate,
      termMonths: input.termMonths,
    })
    .run();

  ctx.writeAuditEntry("create_amortization_plan", "liability", input.liabilityId, {
    planId: input.id,
  });
}

function readAmortizationPlan(
  ctx: StoreContext,
  liabilityId: string,
): AmortizationPlanRecord | null {
  const row = ctx.db
    .select()
    .from(amortizationPlans)
    .where(eq(amortizationPlans.liabilityId, liabilityId))
    .get();

  if (!row) return null;

  return {
    annualInterestRate: row.annualInterestRate,
    id: row.id,
    initialCapitalMinor: row.initialCapitalMinor,
    liabilityId: row.liabilityId,
    startDate: row.startDate,
    termMonths: row.termMonths,
  };
}

function updateAmortizationPlan(
  ctx: StoreContext,
  planId: string,
  input: UpdateAmortizationPlanInput,
): number {
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
  if (input.startDate !== undefined) {
    assertIsoDate(input.startDate, "Start date");
  }
  if (input.annualInterestRate !== undefined) {
    assertDecimalString(input.annualInterestRate, "Annual interest rate");
  }

  const existing = ctx.db
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
  if (input.startDate !== undefined) fields.startDate = input.startDate;

  const result = ctx.db
    .update(amortizationPlans)
    .set(fields)
    .where(eq(amortizationPlans.id, planId))
    .run();

  if (result.changes > 0) {
    ctx.writeAuditEntry("update_amortization_plan", "liability", existing.liabilityId, {
      planId,
      ...input,
    });
  }
  return result.changes;
}

function deleteAmortizationPlan(ctx: StoreContext, planId: string): number {
  const row = ctx.db
    .select({ liabilityId: amortizationPlans.liabilityId })
    .from(amortizationPlans)
    .where(eq(amortizationPlans.id, planId))
    .get();

  if (!row) return 0;

  const result = ctx.db
    .delete(amortizationPlans)
    .where(eq(amortizationPlans.id, planId))
    .run();

  if (result.changes > 0) {
    ctx.writeAuditEntry("delete_amortization_plan", "liability", row.liabilityId, {
      planId,
    });
  }
  return result.changes;
}

function addInterestRateRevision(
  ctx: StoreContext,
  input: AddInterestRateRevisionInput,
): void {
  assertIsoDate(input.revisionDate, "Revision date");
  assertDecimalString(input.newAnnualInterestRate, "Annual interest rate");

  ctx.db
    .insert(interestRateRevisions)
    .values({
      id: input.id,
      newAnnualInterestRate: input.newAnnualInterestRate,
      planId: input.planId,
      revisionDate: input.revisionDate,
    })
    .run();

  ctx.writeAuditEntry("add_rate_revision", "amortization_plan", input.planId, {
    newAnnualInterestRate: input.newAnnualInterestRate,
    revisionDate: input.revisionDate,
    revisionId: input.id,
  });
}

function readInterestRateRevisions(
  ctx: StoreContext,
  planId: string,
): InterestRateRevisionRecord[] {
  const rows = ctx.db
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

function updateInterestRateRevision(
  ctx: StoreContext,
  revisionId: string,
  input: UpdateInterestRateRevisionInput,
): number {
  if (input.revisionDate !== undefined) {
    assertIsoDate(input.revisionDate, "Revision date");
  }
  if (input.newAnnualInterestRate !== undefined) {
    assertDecimalString(input.newAnnualInterestRate, "Annual interest rate");
  }

  const existing = ctx.db
    .select({ planId: interestRateRevisions.planId })
    .from(interestRateRevisions)
    .where(eq(interestRateRevisions.id, revisionId))
    .get();

  if (!existing) return 0;

  const fields: Partial<typeof interestRateRevisions.$inferInsert> = {};
  if (input.revisionDate !== undefined) fields.revisionDate = input.revisionDate;
  if (input.newAnnualInterestRate !== undefined) {
    fields.newAnnualInterestRate = input.newAnnualInterestRate;
  }

  const result = ctx.db
    .update(interestRateRevisions)
    .set(fields)
    .where(eq(interestRateRevisions.id, revisionId))
    .run();

  if (result.changes > 0) {
    ctx.writeAuditEntry("update_rate_revision", "amortization_plan", existing.planId, {
      revisionId,
      ...input,
    });
  }
  return result.changes;
}

function deleteInterestRateRevision(ctx: StoreContext, revisionId: string): number {
  const row = ctx.db
    .select({ planId: interestRateRevisions.planId })
    .from(interestRateRevisions)
    .where(eq(interestRateRevisions.id, revisionId))
    .get();

  if (!row) return 0;

  const result = ctx.db
    .delete(interestRateRevisions)
    .where(eq(interestRateRevisions.id, revisionId))
    .run();

  if (result.changes > 0) {
    ctx.writeAuditEntry("delete_rate_revision", "amortization_plan", row.planId, {
      revisionId,
    });
  }
  return result.changes;
}

function addEarlyRepayment(ctx: StoreContext, input: AddEarlyRepaymentInput): void {
  assertIsoDate(input.repaymentDate, "Repayment date");
  if (!Number.isInteger(input.amountMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }

  ctx.db
    .insert(earlyRepayments)
    .values({
      amountMinor: input.amountMinor,
      id: input.id,
      mode: input.mode,
      planId: input.planId,
      repaymentDate: input.repaymentDate,
    })
    .run();

  ctx.writeAuditEntry("add_early_repayment", "amortization_plan", input.planId, {
    amountMinor: input.amountMinor,
    mode: input.mode,
    repaymentDate: input.repaymentDate,
    repaymentId: input.id,
  });
}

function readEarlyRepayments(ctx: StoreContext, planId: string): EarlyRepaymentRecord[] {
  const rows = ctx.db
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

function updateEarlyRepayment(
  ctx: StoreContext,
  repaymentId: string,
  input: UpdateEarlyRepaymentInput,
): number {
  if (input.repaymentDate !== undefined) {
    assertIsoDate(input.repaymentDate, "Repayment date");
  }
  if (input.amountMinor !== undefined && !Number.isInteger(input.amountMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }

  const existing = ctx.db
    .select({ planId: earlyRepayments.planId })
    .from(earlyRepayments)
    .where(eq(earlyRepayments.id, repaymentId))
    .get();

  if (!existing) return 0;

  const fields: Partial<typeof earlyRepayments.$inferInsert> = {};
  if (input.repaymentDate !== undefined) fields.repaymentDate = input.repaymentDate;
  if (input.amountMinor !== undefined) fields.amountMinor = input.amountMinor;
  if (input.mode !== undefined) fields.mode = input.mode;

  const result = ctx.db
    .update(earlyRepayments)
    .set(fields)
    .where(eq(earlyRepayments.id, repaymentId))
    .run();

  if (result.changes > 0) {
    ctx.writeAuditEntry("update_early_repayment", "amortization_plan", existing.planId, {
      repaymentId,
      ...input,
    });
  }
  return result.changes;
}

function deleteEarlyRepayment(ctx: StoreContext, repaymentId: string): number {
  const row = ctx.db
    .select({ planId: earlyRepayments.planId })
    .from(earlyRepayments)
    .where(eq(earlyRepayments.id, repaymentId))
    .get();

  if (!row) return 0;

  const result = ctx.db
    .delete(earlyRepayments)
    .where(eq(earlyRepayments.id, repaymentId))
    .run();

  if (result.changes > 0) {
    ctx.writeAuditEntry("delete_early_repayment", "amortization_plan", row.planId, {
      repaymentId,
    });
  }
  return result.changes;
}

function amortizableBalanceAtDateFor(
  ctx: StoreContext,
  liabilityId: string,
  targetDate: string,
): number {
  const plan = readAmortizationPlan(ctx, liabilityId);
  if (!plan) {
    throw new Error(`Liability "${liabilityId}" has no amortization plan.`);
  }

  const revisions = readInterestRateRevisions(ctx, plan.id).map((revision) => ({
    newAnnualInterestRate: revision.newAnnualInterestRate,
    revisionDate: revision.revisionDate,
  }));

  const repayments = readEarlyRepayments(ctx, plan.id).map((repayment) => ({
    amountMinor: repayment.amountMinor,
    mode: repayment.mode,
    repaymentDate: repayment.repaymentDate,
  }));

  return amortizableBalanceAtDate({
    earlyRepayments: repayments,
    plan: {
      annualInterestRate: plan.annualInterestRate,
      initialCapitalMinor: plan.initialCapitalMinor,
      startDate: plan.startDate,
      termMonths: plan.termMonths,
    },
    revisions,
    targetDate,
  });
}

function addBalanceAnchor(ctx: StoreContext, input: AddBalanceAnchorInput): void {
  if (!Number.isInteger(input.balanceMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }
  assertIsoDate(input.anchorDate, "Anchor date");

  // The "liability must be revolving/informal" invariant is a domain/caller
  // guard (R9), not enforced here. The unique index on (liability_id,
  // anchor_date) keeps one anchor per liability per date — a collision throws.
  ctx.db
    .insert(liabilityBalanceAnchors)
    .values({
      anchorDate: input.anchorDate,
      balanceMinor: input.balanceMinor,
      id: input.id,
      liabilityId: input.liabilityId,
    })
    .run();

  ctx.writeAuditEntry("add_balance_anchor", "liability", input.liabilityId, {
    anchorDate: input.anchorDate,
    anchorId: input.id,
    balanceMinor: input.balanceMinor,
  });
}

function readBalanceAnchors(
  ctx: StoreContext,
  liabilityId: string,
): BalanceAnchorRecord[] {
  const rows = ctx.db
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

function updateBalanceAnchor(
  ctx: StoreContext,
  anchorId: string,
  input: UpdateBalanceAnchorInput,
): number {
  if (input.balanceMinor !== undefined && !Number.isInteger(input.balanceMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }
  if (input.anchorDate !== undefined) {
    assertIsoDate(input.anchorDate, "Anchor date");
  }

  const existing = ctx.db
    .select({ liabilityId: liabilityBalanceAnchors.liabilityId })
    .from(liabilityBalanceAnchors)
    .where(eq(liabilityBalanceAnchors.id, anchorId))
    .get();

  if (!existing) return 0;

  const fields: Partial<typeof liabilityBalanceAnchors.$inferInsert> = {};
  if (input.balanceMinor !== undefined) fields.balanceMinor = input.balanceMinor;
  if (input.anchorDate !== undefined) fields.anchorDate = input.anchorDate;

  const result = ctx.db
    .update(liabilityBalanceAnchors)
    .set(fields)
    .where(eq(liabilityBalanceAnchors.id, anchorId))
    .run();

  if (result.changes > 0) {
    ctx.writeAuditEntry("update_balance_anchor", "liability", existing.liabilityId, {
      anchorId,
      ...input,
    });
  }
  return result.changes;
}

function deleteBalanceAnchor(ctx: StoreContext, anchorId: string): number {
  const row = ctx.db
    .select({ liabilityId: liabilityBalanceAnchors.liabilityId })
    .from(liabilityBalanceAnchors)
    .where(eq(liabilityBalanceAnchors.id, anchorId))
    .get();

  if (!row) return 0;

  const result = ctx.db
    .delete(liabilityBalanceAnchors)
    .where(eq(liabilityBalanceAnchors.id, anchorId))
    .run();

  if (result.changes > 0) {
    ctx.writeAuditEntry("delete_balance_anchor", "liability", row.liabilityId, {
      anchorId,
    });
  }
  return result.changes;
}

function debtBalanceAtDateFor(
  ctx: StoreContext,
  liabilityId: string,
  targetDate: string,
): number {
  const row = ctx.db
    .select({
      currentBalanceMinor: liabilities.currentBalanceMinor,
      debtModel: liabilities.debtModel,
    })
    .from(liabilities)
    .where(eq(liabilities.id, liabilityId))
    .get();

  if (!row) {
    throw new Error(`Liability "${liabilityId}" not found.`);
  }

  const currentBalanceMinor = row.currentBalanceMinor;
  const debtModel = row.debtModel ?? null;

  if (debtModel === "amortizable") {
    const plan = readAmortizationPlan(ctx, liabilityId);
    if (!plan) {
      return debtBalanceAtDate({ currentBalanceMinor, debtModel, targetDate });
    }
    const revisions = readInterestRateRevisions(ctx, plan.id).map((revision) => ({
      newAnnualInterestRate: revision.newAnnualInterestRate,
      revisionDate: revision.revisionDate,
    }));
    const repayments = readEarlyRepayments(ctx, plan.id).map((repayment) => ({
      amountMinor: repayment.amountMinor,
      mode: repayment.mode,
      repaymentDate: repayment.repaymentDate,
    }));
    return debtBalanceAtDate({
      currentBalanceMinor,
      debtModel,
      earlyRepayments: repayments,
      plan: {
        annualInterestRate: plan.annualInterestRate,
        initialCapitalMinor: plan.initialCapitalMinor,
        startDate: plan.startDate,
        termMonths: plan.termMonths,
      },
      revisions,
      targetDate,
    });
  }

  const anchors = readBalanceAnchors(ctx, liabilityId).map((anchor) => ({
    anchorDate: anchor.anchorDate,
    balanceMinor: anchor.balanceMinor,
  }));

  return debtBalanceAtDate({ anchors, currentBalanceMinor, debtModel, targetDate });
}

function createLiabilityRecord(ctx: StoreContext, input: CreateLiabilityInput): void {
  const { db } = ctx;
  const workspace = ctx.getWorkspace();

  if (!workspace) {
    throw new Error("Workspace must be initialized before creating liabilities.");
  }

  // The split rule is enforced at the write boundary (createLiabilitySafe, which
  // allows a known partial for a debt on a co-owned home — #171). This low-level
  // persist only constructs the row, so it accepts ≤100% rather than re-asserting
  // strict 100% and rejecting an already-approved partial split.
  const liability = createLiability(workspace, input, { allowKnownPartial: true });
  ctx.transaction(() => {
    db.insert(liabilities)
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
      db.insert(liabilityOwnerships)
        .values(
          liability.ownership.map((share) => ({
            liabilityId: liability.id,
            memberId: share.memberId,
            shareBps: share.shareBps,
          })),
        )
        .run();
    }
  });

  ctx.writeAuditEntry("create_liability", "liability", liability.id);
}

function updateLiability(
  ctx: StoreContext,
  liabilityId: string,
  input: UpdateLiabilityInput,
): void {
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

  ctx.transaction(() => {
    if (Object.keys(fields).length > 0) {
      db.update(liabilities)
        .set({ ...fields, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(liabilities.id, liabilityId))
        .run();
    }

    if (input.ownership !== undefined) {
      db.delete(liabilityOwnerships)
        .where(eq(liabilityOwnerships.liabilityId, liabilityId))
        .run();

      if (input.ownership.length > 0) {
        db.insert(liabilityOwnerships)
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

  ctx.writeAuditEntry("update_liability", "liability", liabilityId, {
    ...input,
    ownership: undefined,
  });
}

function updateLiabilityBalance(
  ctx: StoreContext,
  liabilityId: string,
  balanceMinor: number,
): void {
  const { db } = ctx;

  if (!Number.isInteger(balanceMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }

  db.update(liabilities)
    .set({ currentBalanceMinor: balanceMinor, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(liabilities.id, liabilityId))
    .run();
  ctx.writeAuditEntry("update_balance", "liability", liabilityId, { balanceMinor });
}

function softDeleteLiability(
  ctx: StoreContext,
  liabilityId: string,
  deletedAt: string,
): number {
  const result = ctx.db
    .update(liabilities)
    .set({ deletedAt })
    .where(eq(liabilities.id, liabilityId))
    .run();
  if (result.changes > 0) {
    ctx.writeAuditEntry("delete_liability", "liability", liabilityId, { deletedAt });
  }
  return result.changes;
}

function restoreLiability(ctx: StoreContext, liabilityId: string): number {
  const result = ctx.db
    .update(liabilities)
    .set({ deletedAt: null })
    .where(and(eq(liabilities.id, liabilityId), isNotNull(liabilities.deletedAt)))
    .run();
  if (result.changes > 0) {
    ctx.writeAuditEntry("restore_liability", "liability", liabilityId);
  }
  return result.changes;
}
