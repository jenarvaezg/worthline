import type {
  AmortizationPlanInput,
  EarlyRepayment,
  EarlyRepaymentMode,
} from "@worthline/domain";
import { assertEventWithinTerm } from "@worthline/domain";
import { asc, eq } from "drizzle-orm";
import { chunk } from "./chunk";
import {
  readLiabilityIdForPlan,
  readPlanInputById,
} from "./liability-amortization-plan-store";
import { assertIsoDate, assertMinorUnits } from "./liability-fact-guards";
import { earlyRepayments } from "./schema";
import type { StoreContext } from "./store-context";

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
  /**
   * Who wrote the fact (#1245): `manual` (the default, the edit UI) or `agent` (a
   * confirmed assistant proposal). Never a grade of evidence.
   */
  source?: "manual" | "agent";
}

/** A stored early repayment as read back from the store. */
export interface EarlyRepaymentRecord extends EarlyRepayment {
  id: string;
  planId: string;
  source: "manual" | "agent";
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

/**
 * Early repayments: the dated fact that pays principal down ahead of the
 * schedule (PRD #146). One family, one module (#1604) — the mode decides whether
 * the cuota or the term gives way, and neither is a property of the plan row.
 */
export interface EarlyRepaymentStore {
  /** Add an early repayment to a plan. */
  addEarlyRepayment: (input: AddEarlyRepaymentInput) => Promise<void>;
  /**
   * Add a whole BATCH of early repayments in batched writes (#1440) — sibling of
   * `addInterestRateRevisions` for the same cuadro import.
   */
  addEarlyRepayments: (inputs: readonly AddEarlyRepaymentInput[]) => Promise<void>;
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
}

export function createEarlyRepaymentStore(ctx: StoreContext): EarlyRepaymentStore {
  return {
    addEarlyRepayment: (input) => addEarlyRepayments(ctx, [input]),
    addEarlyRepayments: (inputs) => addEarlyRepayments(ctx, inputs),
    readEarlyRepayments: (planId) => readEarlyRepayments(ctx, planId),
    updateEarlyRepayment: (repaymentId, input) =>
      updateEarlyRepayment(ctx, repaymentId, input),
    deleteEarlyRepayment: (repaymentId) => deleteEarlyRepayment(ctx, repaymentId),
  };
}

/**
 * Early-repayment rows per batched INSERT. Six columns each, so a group of 50
 * stays well below the per-statement parameter cap (#1440).
 */
const REPAYMENTS_PER_INSERT = 50;

function repaymentRow(input: AddEarlyRepaymentInput) {
  return {
    amountMinor: input.amountMinor,
    id: input.id,
    mode: input.mode,
    planId: input.planId,
    repaymentDate: input.repaymentDate,
    source: input.source ?? "manual",
  };
}

/**
 * Persist a whole BATCH of early repayments (#1440). Sibling of
 * `addInterestRateRevisions`: the cuadro import owns the transaction.
 */
async function addEarlyRepayments(
  ctx: StoreContext,
  inputs: readonly AddEarlyRepaymentInput[],
): Promise<void> {
  if (inputs.length === 0) return;

  for (const input of inputs) {
    assertIsoDate(input.repaymentDate, "Repayment date");
    assertMinorUnits(input.amountMinor);
  }

  const plansById = new Map<string, AmortizationPlanInput | null>();
  for (const planId of new Set(inputs.map((input) => input.planId))) {
    plansById.set(planId, await readPlanInputById(ctx, planId));
  }
  for (const input of inputs) {
    // #210: an event past the loan's final payment boundary resolves outside the
    // term and would be silently dropped by the schedule build loop — reject it.
    const plan = plansById.get(input.planId);
    if (plan) assertEventWithinTerm(plan, input.repaymentDate, "Repayment date");
  }

  for (const group of chunk(inputs, REPAYMENTS_PER_INSERT)) {
    await ctx.db.insert(earlyRepayments).values(group.map(repaymentRow)).run();
  }

  await ctx.writeAuditEntries(
    inputs.map((input) => ({
      action: "add_early_repayment",
      details: {
        amountMinor: input.amountMinor,
        mode: input.mode,
        repaymentDate: input.repaymentDate,
        repaymentId: input.id,
        source: input.source ?? "manual",
      },
      entityId: input.planId,
      entityType: "amortization_plan",
    })),
  );
}

export async function readEarlyRepayments(
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
    source: row.source,
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
  if (input.amountMinor !== undefined) {
    assertMinorUnits(input.amountMinor);
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
