import type { ContributionAllowance, ManualAsset } from "@worthline/domain";
import {
  assertContributionAllowanceInput,
  consumesContributionAllowance,
} from "@worthline/domain";
import { asc, eq, inArray, sql } from "drizzle-orm";

import { assets, contributionAllowanceHoldings, contributionAllowances } from "./schema";
import type { StoreContext } from "./store-context";

/**
 * Annual contribution allowance persistence (#1427) — the "cupo anual de
 * aportación" rows and the holdings that consume them.
 *
 * Only the ceiling is stored. What has been consumed is derived from the
 * operation ledger on read (`computeContributionAllowanceUsage`), so a corrected
 * operation moves the counter with it and no total can go stale behind the user's
 * back. An allowance owns its destination set, so create/update rewrite the link
 * rows atomically and delete removes both explicitly — the connection's
 * foreign-key pragma is not assumed on (same rule as the goal store).
 */
export interface CreateContributionAllowanceInput {
  scopeId: string;
  label: string;
  annualCapMinor: number;
  holdingIds: string[];
}

export interface UpdateContributionAllowancePatch {
  label?: string;
  annualCapMinor?: number;
  holdingIds?: string[];
}

export interface ContributionAllowanceStore {
  /** A scope's allowances with their destination sets, ordered by label. */
  readContributionAllowances: (scopeId: string) => Promise<ContributionAllowance[]>;
  createContributionAllowance: (
    input: CreateContributionAllowanceInput,
  ) => Promise<ContributionAllowance>;
  updateContributionAllowance: (
    id: string,
    patch: UpdateContributionAllowancePatch,
  ) => Promise<void>;
  deleteContributionAllowance: (id: string) => Promise<void>;
}

export function createContributionAllowanceStore(
  ctx: StoreContext,
): ContributionAllowanceStore {
  return {
    readContributionAllowances: (scopeId) => readContributionAllowances(ctx, scopeId),
    createContributionAllowance: (input) => createContributionAllowance(ctx, input),
    updateContributionAllowance: (id, patch) =>
      updateContributionAllowance(ctx, id, patch),
    deleteContributionAllowance: (id) => deleteContributionAllowance(ctx, id),
  };
}

/**
 * Every destination must be a pension plan with an operation ledger (#1567).
 *
 * The cupo counts aportaciones to plans, not every investment. Pointing one at a
 * fund or a cash account would either invent a contribution that is not fiscal,
 * or print "0 € de 1.500 €". The action no longer offers a picker; this is the
 * rule at the door, so no other writer can get around it.
 */
async function assertPensionPlanDestinations(
  ctx: StoreContext,
  holdingIds: readonly string[],
): Promise<void> {
  const rows = await ctx.db
    .select({
      connectedSourceId: assets.connectedSourceId,
      id: assets.id,
      instrument: assets.instrument,
      isPrimaryResidence: assets.isPrimaryResidence,
      type: assets.type,
    })
    .from(assets)
    .where(inArray(assets.id, [...holdingIds]))
    .all();
  const rowById = new Map(rows.map((row) => [row.id, row]));

  for (const holdingId of holdingIds) {
    const row = rowById.get(holdingId);
    if (row === undefined) {
      throw new Error(`El activo "${holdingId}" no existe.`);
    }
    // Only the fields the predicate reads — it derives the method from the
    // instrument, exactly as every read path does.
    const asset = {
      instrument: row.instrument ?? undefined,
      isPrimaryResidence: row.isPrimaryResidence === 1,
      type: row.type,
      ...(row.connectedSourceId != null
        ? { connectedSourceId: row.connectedSourceId }
        : {}),
    } as ManualAsset;
    if (!consumesContributionAllowance(asset)) {
      throw new Error(
        "Un cupo solo cuenta aportaciones a planes de pensiones: son el instrumento nativo, y los únicos que registran cada aportación una a una.",
      );
    }
  }
}

/** Destinations are a set: the same holding twice would double-count its entries. */
function normalizeHoldingIds(holdingIds: readonly string[]): string[] {
  return [...new Set(holdingIds.map((id) => id.trim()).filter(Boolean))];
}

async function readContributionAllowances(
  ctx: StoreContext,
  scopeId: string,
): Promise<ContributionAllowance[]> {
  const rows = await ctx.db
    .select()
    .from(contributionAllowances)
    .where(eq(contributionAllowances.scopeId, scopeId))
    .orderBy(asc(contributionAllowances.label), asc(contributionAllowances.id))
    .all();

  if (rows.length === 0) return [];

  const links = await ctx.db
    .select()
    .from(contributionAllowanceHoldings)
    .where(
      inArray(
        contributionAllowanceHoldings.allowanceId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(contributionAllowanceHoldings.assetId))
    .all();

  const holdingsByAllowance = new Map<string, string[]>();
  for (const link of links) {
    const list = holdingsByAllowance.get(link.allowanceId) ?? [];
    list.push(link.assetId);
    holdingsByAllowance.set(link.allowanceId, list);
  }

  return rows.map((row) => ({
    annualCapMinor: row.annualCapMinor,
    holdingIds: holdingsByAllowance.get(row.id) ?? [],
    id: row.id,
    label: row.label,
    scopeId: row.scopeId,
  }));
}

async function createContributionAllowance(
  ctx: StoreContext,
  input: CreateContributionAllowanceInput,
): Promise<ContributionAllowance> {
  const holdingIds = normalizeHoldingIds(input.holdingIds);
  const label = input.label.trim();
  assertContributionAllowanceInput({
    annualCapMinor: input.annualCapMinor,
    holdingIds,
    label,
  });
  if (!input.scopeId.trim()) throw new Error("scopeId is required.");
  await assertPensionPlanDestinations(ctx, holdingIds);

  const id = ctx.newId();
  await ctx.transaction(async () => {
    await ctx.db
      .insert(contributionAllowances)
      .values({
        annualCapMinor: input.annualCapMinor,
        id,
        label,
        scopeId: input.scopeId,
      })
      .run();
    await insertHoldings(ctx, id, holdingIds);
  });

  return {
    annualCapMinor: input.annualCapMinor,
    holdingIds,
    id,
    label,
    scopeId: input.scopeId,
  };
}

async function updateContributionAllowance(
  ctx: StoreContext,
  id: string,
  patch: UpdateContributionAllowancePatch,
): Promise<void> {
  const existing = await ctx.db
    .select()
    .from(contributionAllowances)
    .where(eq(contributionAllowances.id, id))
    .get();
  if (!existing) throw new Error(`Contribution allowance "${id}" not found.`);

  const currentHoldings = (
    await ctx.db
      .select({ assetId: contributionAllowanceHoldings.assetId })
      .from(contributionAllowanceHoldings)
      .where(eq(contributionAllowanceHoldings.allowanceId, id))
      .all()
  ).map((row) => row.assetId);

  const label = (patch.label ?? existing.label).trim();
  const annualCapMinor = patch.annualCapMinor ?? existing.annualCapMinor;
  const holdingIds = normalizeHoldingIds(patch.holdingIds ?? currentHoldings);
  assertContributionAllowanceInput({ annualCapMinor, holdingIds, label });
  if (patch.holdingIds !== undefined) {
    await assertPensionPlanDestinations(ctx, holdingIds);
  }

  await ctx.transaction(async () => {
    await ctx.db
      .update(contributionAllowances)
      .set({ annualCapMinor, label, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(contributionAllowances.id, id))
      .run();
    if (patch.holdingIds !== undefined) {
      await ctx.db
        .delete(contributionAllowanceHoldings)
        .where(eq(contributionAllowanceHoldings.allowanceId, id))
        .run();
      await insertHoldings(ctx, id, holdingIds);
    }
  });
}

async function deleteContributionAllowance(ctx: StoreContext, id: string): Promise<void> {
  await ctx.transaction(async () => {
    await ctx.db
      .delete(contributionAllowanceHoldings)
      .where(eq(contributionAllowanceHoldings.allowanceId, id))
      .run();
    await ctx.db
      .delete(contributionAllowances)
      .where(eq(contributionAllowances.id, id))
      .run();
  });
}

async function insertHoldings(
  ctx: StoreContext,
  allowanceId: string,
  holdingIds: readonly string[],
): Promise<void> {
  if (holdingIds.length === 0) return;
  await ctx.db
    .insert(contributionAllowanceHoldings)
    .values(holdingIds.map((assetId) => ({ allowanceId, assetId })))
    .run();
}
