import type {
  ContributionCadence,
  ContributionPlan,
  PlannedContribution,
  PlannedContributionAmount,
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

function rowToContribution(row: Row): PlannedContribution {
  return {
    id: row.id,
    destinationHoldingId: row.destinationHoldingId,
    amount: JSON.parse(row.amountJson) as PlannedContributionAmount,
    cadence: JSON.parse(row.cadenceJson) as ContributionCadence,
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

async function createPlannedContribution(
  ctx: StoreContext,
  input: CreatePlannedContributionInput,
): Promise<PlannedContribution> {
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
