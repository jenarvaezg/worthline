import type {
  ContributionCadence,
  ContributionPlan,
  PlannedContribution,
  PlannedContributionAmount,
} from "@worthline/domain";
import {
  assertContributionCadence,
  assertPlannedContributionInput,
  parsePlannedContributionAmount,
} from "@worthline/domain";
import { asc, eq } from "drizzle-orm";

import { plannedContributions } from "./schema";
import type { StoreContext } from "./store-context";

/**
 * Contribution-plan persistence (ADR 0041, PRD #553 S1). Stores a scope's planned
 * contributions as forecast metadata only — occurrences are derived on read and
 * reconciliation rows belong in S2.
 */

export interface CreatePlannedContributionInput {
  scopeId: string;
  destinationHoldingId: string;
  amount: PlannedContributionAmount;
  cadence: ContributionCadence;
  startDate: string;
  endDate?: string;
}

export interface UpdatePlannedContributionPatch {
  destinationHoldingId?: string;
  amount?: PlannedContributionAmount;
  cadence?: ContributionCadence;
  startDate?: string;
  endDate?: string | null;
}

export interface ContributionPlanStore {
  readContributionPlan: (scopeId: string) => Promise<ContributionPlan>;
  createPlannedContribution: (
    input: CreatePlannedContributionInput,
  ) => Promise<PlannedContribution>;
  updatePlannedContribution: (
    id: string,
    patch: UpdatePlannedContributionPatch,
  ) => Promise<void>;
  deletePlannedContribution: (id: string) => Promise<void>;
}

export function createContributionPlanStore(ctx: StoreContext): ContributionPlanStore {
  return {
    readContributionPlan: (scopeId) => readContributionPlan(ctx, scopeId),
    createPlannedContribution: (input) => createPlannedContribution(ctx, input),
    updatePlannedContribution: (id, patch) => updatePlannedContribution(ctx, id, patch),
    deletePlannedContribution: (id) => deletePlannedContribution(ctx, id),
  };
}

type Row = typeof plannedContributions.$inferSelect;

function parseCadenceJson(raw: string): ContributionCadence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Planned contribution cadence must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || !("kind" in parsed)) {
    throw new Error("Planned contribution cadence is invalid.");
  }
  const cadence = parsed as ContributionCadence;
  assertContributionCadence(cadence);
  return cadence;
}

function rowToContribution(row: Row): PlannedContribution {
  let amountRaw: unknown;
  try {
    amountRaw = JSON.parse(row.amountJson);
  } catch {
    throw new Error(`Planned contribution "${row.id}" has invalid amount JSON.`);
  }
  const amount = parsePlannedContributionAmount(amountRaw);
  const cadence = parseCadenceJson(row.cadenceJson);
  assertPlannedContributionInput({
    destinationHoldingId: row.destinationHoldingId,
    amount,
    cadence,
    startDate: row.startDate,
    endDate: row.endDate,
  });
  return {
    id: row.id,
    destinationHoldingId: row.destinationHoldingId,
    amount,
    cadence,
    startDate: row.startDate,
    ...(row.endDate != null ? { endDate: row.endDate } : {}),
  };
}

async function readContributionPlan(
  ctx: StoreContext,
  scopeId: string,
): Promise<ContributionPlan> {
  const rows = await ctx.db
    .select()
    .from(plannedContributions)
    .where(eq(plannedContributions.scopeId, scopeId))
    .orderBy(asc(plannedContributions.startDate), asc(plannedContributions.id))
    .all();

  return {
    scopeId,
    contributions: rows.map(rowToContribution),
  };
}

async function readContributionRow(
  ctx: StoreContext,
  id: string,
): Promise<Row | undefined> {
  return ctx.db
    .select()
    .from(plannedContributions)
    .where(eq(plannedContributions.id, id))
    .get();
}

async function createPlannedContribution(
  ctx: StoreContext,
  input: CreatePlannedContributionInput,
): Promise<PlannedContribution> {
  assertPlannedContributionInput(input);
  const id = ctx.newId();
  const endDate = input.endDate ?? null;
  await ctx.db
    .insert(plannedContributions)
    .values({
      id,
      scopeId: input.scopeId,
      destinationHoldingId: input.destinationHoldingId,
      amountJson: JSON.stringify(input.amount),
      cadenceJson: JSON.stringify(input.cadence),
      startDate: input.startDate,
      endDate,
    })
    .run();

  return {
    id,
    destinationHoldingId: input.destinationHoldingId,
    amount: input.amount,
    cadence: input.cadence,
    startDate: input.startDate,
    ...(endDate != null ? { endDate } : {}),
  };
}

async function updatePlannedContribution(
  ctx: StoreContext,
  id: string,
  patch: UpdatePlannedContributionPatch,
): Promise<void> {
  const existing = await readContributionRow(ctx, id);
  if (!existing) {
    throw new Error(`Planned contribution "${id}" not found.`);
  }

  const current = rowToContribution(existing);
  const next = {
    destinationHoldingId: patch.destinationHoldingId ?? current.destinationHoldingId,
    amount: patch.amount ?? current.amount,
    cadence: patch.cadence ?? current.cadence,
    startDate: patch.startDate ?? current.startDate,
    endDate: patch.endDate === undefined ? current.endDate : (patch.endDate ?? undefined),
  };
  assertPlannedContributionInput({
    ...next,
    endDate: next.endDate ?? null,
  });

  const set: Partial<typeof plannedContributions.$inferInsert> = {};
  if (patch.destinationHoldingId !== undefined) {
    set.destinationHoldingId = patch.destinationHoldingId;
  }
  if (patch.amount !== undefined) {
    set.amountJson = JSON.stringify(patch.amount);
  }
  if (patch.cadence !== undefined) {
    set.cadenceJson = JSON.stringify(patch.cadence);
  }
  if (patch.startDate !== undefined) {
    set.startDate = patch.startDate;
  }
  if (patch.endDate !== undefined) {
    set.endDate = patch.endDate;
  }
  if (Object.keys(set).length === 0) return;
  await ctx.db
    .update(plannedContributions)
    .set(set)
    .where(eq(plannedContributions.id, id))
    .run();
}

async function deletePlannedContribution(ctx: StoreContext, id: string): Promise<void> {
  await ctx.db.delete(plannedContributions).where(eq(plannedContributions.id, id)).run();
}
