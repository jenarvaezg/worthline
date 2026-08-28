import type { BalanceRebaselineInput, DecimalString } from "@worthline/domain";
import { deriveCurrentStateAmortizationPlan } from "@worthline/domain";
import { asc, eq } from "drizzle-orm";
import { chunk } from "./chunk";
import type { FactPersistenceProvenance } from "./fact-provenance";
import { liabilityBalanceRebaselines } from "./schema";
import type { StoreContext } from "./store-context";

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

/**
 * Current-state balance re-baselines: the dated fact that restates an
 * amortizable liability's outstanding principal on a date and re-derives the
 * schedule from there. One family, one module (#1604) — a re-baseline is a
 * checkpoint of the curve, not an edit of the contracted plan.
 */
export interface BalanceRebaselineStore {
  /** Add a current-state balance re-baseline to an amortizable liability. */
  addBalanceRebaseline: (
    input: AddBalanceRebaselineInput,
    provenance?: FactPersistenceProvenance,
  ) => Promise<void>;
  /**
   * Add a whole CHAIN of re-baselines in batched writes (#1435) — the shape a
   * balance-history reconstruction needs, where one round-trip per checkpoint is
   * dozens of round-trips.
   */
  addBalanceRebaselines: (
    inputs: readonly AddBalanceRebaselineInput[],
    provenance?: FactPersistenceProvenance,
  ) => Promise<void>;
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
}

export function createBalanceRebaselineStore(ctx: StoreContext): BalanceRebaselineStore {
  return {
    addBalanceRebaseline: (input, opts) => addBalanceRebaselines(ctx, [input], opts),
    addBalanceRebaselines: (inputs, opts) => addBalanceRebaselines(ctx, inputs, opts),
    readBalanceRebaselines: (liabilityId) => readBalanceRebaselines(ctx, liabilityId),
    updateBalanceRebaseline: (rebaselineId, input) =>
      updateBalanceRebaseline(ctx, rebaselineId, input),
    deleteBalanceRebaseline: (rebaselineId) => deleteBalanceRebaseline(ctx, rebaselineId),
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

/**
 * Re-baseline rows per batched INSERT. Twelve columns each, so a group of 50
 * stays well below the per-statement parameter cap (#1435).
 */
const REBASELINES_PER_INSERT = 50;

function rebaselineRow(
  input: AddBalanceRebaselineInput,
  provenance?: FactPersistenceProvenance,
) {
  const derived = deriveRebaselineStorage(input);
  return {
    annualInterestRate: derived.annualInterestRate,
    baselineDate: input.baselineDate,
    batchId: provenance?.batchId ?? null,
    endDate: input.endDate,
    id: input.id,
    inputMode: derived.inputMode,
    liabilityId: input.liabilityId,
    monthlyPaymentMinor: derived.monthlyPaymentMinor,
    nextPaymentDate: input.nextPaymentDate,
    outstandingBalanceMinor: input.outstandingBalanceMinor,
    startsAtBaseline: input.startsAtBaseline ?? false,
    source: input.source ?? "manual",
  };
}

/**
 * Persist a whole CHAIN of re-baselines (#1435). A reconstruction import applies
 * dozens of checkpoints at once; one `await` per checkpoint is one round-trip per
 * checkpoint against a remote Turso, so the rows — and their audit trail, still
 * one row per fact — go in batched.
 *
 * A chain longer than one chunk spans several statements, so the CALLER owns the
 * transaction (every one of them applies the chain inside `ctx.transaction`, ADR
 * 0020) — without it a long chain could land half-written.
 */
async function addBalanceRebaselines(
  ctx: StoreContext,
  inputs: readonly AddBalanceRebaselineInput[],
  provenance?: FactPersistenceProvenance,
): Promise<void> {
  if (inputs.length === 0) return;

  for (const group of chunk(inputs, REBASELINES_PER_INSERT)) {
    await ctx.db
      .insert(liabilityBalanceRebaselines)
      .values(group.map((input) => rebaselineRow(input, provenance)))
      .run();
  }

  await ctx.writeAuditEntries(
    inputs.map((input) => ({
      action: "add_balance_rebaseline",
      details: { baselineDate: input.baselineDate, rebaselineId: input.id },
      entityId: input.liabilityId,
      entityType: "liability",
    })),
  );
}

export async function readBalanceRebaselines(
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
