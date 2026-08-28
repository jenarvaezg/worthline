import type {
  AmortizationPlanInput,
  DecimalString,
  InterestRateRevision,
} from "@worthline/domain";
import { assertEventWithinTerm } from "@worthline/domain";
import { asc, eq } from "drizzle-orm";
import { chunk } from "./chunk";
import {
  readLiabilityIdForPlan,
  readPlanInputById,
} from "./liability-amortization-plan-store";
import { assertDecimalString, assertIsoDate } from "./liability-fact-guards";
import { interestRateRevisions } from "./schema";
import type { StoreContext } from "./store-context";

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

/**
 * Interest-rate revisions: the dated fact that changes a plan's rate from a date
 * on (PRD #109). One family, one module (#1604) — a new rate never touches the
 * plan row, only the curve the engine folds over it.
 */
export interface InterestRateRevisionStore {
  /** Add an interest-rate revision to a plan. */
  addInterestRateRevision: (input: AddInterestRateRevisionInput) => Promise<void>;
  /**
   * Add a whole BATCH of rate revisions in batched writes (#1440) — the shape a
   * cuadro-de-amortización import needs, where one round-trip per event is
   * dozens of round-trips.
   */
  addInterestRateRevisions: (
    inputs: readonly AddInterestRateRevisionInput[],
  ) => Promise<void>;
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
}

export function createInterestRateRevisionStore(
  ctx: StoreContext,
): InterestRateRevisionStore {
  return {
    addInterestRateRevision: (input) => addInterestRateRevisions(ctx, [input]),
    addInterestRateRevisions: (inputs) => addInterestRateRevisions(ctx, inputs),
    readInterestRateRevisions: (planId) => readInterestRateRevisions(ctx, planId),
    updateInterestRateRevision: (revisionId, input) =>
      updateInterestRateRevision(ctx, revisionId, input),
    deleteInterestRateRevision: (revisionId) =>
      deleteInterestRateRevision(ctx, revisionId),
  };
}

/**
 * Rate-revision rows per batched INSERT. Four columns each, so a group of 50
 * stays well below the per-statement parameter cap (#1440).
 */
const REVISIONS_PER_INSERT = 50;

function revisionRow(input: AddInterestRateRevisionInput) {
  return {
    id: input.id,
    newAnnualInterestRate: input.newAnnualInterestRate,
    planId: input.planId,
    revisionDate: input.revisionDate,
  };
}

/**
 * Persist a whole BATCH of rate revisions (#1440). A cuadro import applies
 * dozens of events at once; one `await` per event is one round-trip per event
 * against a remote Turso, so the rows — and their audit trail, still one row
 * per fact — go in batched.
 *
 * A batch longer than one chunk spans several statements, so the CALLER owns the
 * transaction (the cuadro import applies the batch inside `ctx.transaction`, ADR
 * 0020) — without it a long batch could land half-written.
 */
async function addInterestRateRevisions(
  ctx: StoreContext,
  inputs: readonly AddInterestRateRevisionInput[],
): Promise<void> {
  if (inputs.length === 0) return;

  for (const input of inputs) {
    assertIsoDate(input.revisionDate, "Revision date");
    assertDecimalString(input.newAnnualInterestRate, "Annual interest rate");
  }

  const plansById = new Map<string, AmortizationPlanInput | null>();
  for (const planId of new Set(inputs.map((input) => input.planId))) {
    plansById.set(planId, await readPlanInputById(ctx, planId));
  }
  for (const input of inputs) {
    // #210: an event past the loan's final payment boundary resolves outside the
    // term and would be silently dropped by the schedule build loop — reject it.
    const plan = plansById.get(input.planId);
    if (plan) assertEventWithinTerm(plan, input.revisionDate, "Revision date");
  }

  for (const group of chunk(inputs, REVISIONS_PER_INSERT)) {
    await ctx.db.insert(interestRateRevisions).values(group.map(revisionRow)).run();
  }

  await ctx.writeAuditEntries(
    inputs.map((input) => ({
      action: "add_rate_revision",
      details: {
        newAnnualInterestRate: input.newAnnualInterestRate,
        revisionDate: input.revisionDate,
        revisionId: input.id,
      },
      entityId: input.planId,
      entityType: "amortization_plan",
    })),
  );
}

export async function readInterestRateRevisions(
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
