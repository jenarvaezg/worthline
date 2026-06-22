import type { Goal } from "@worthline/domain";
import { asc, eq, inArray, sql } from "drizzle-orm";

import { goalHoldings, goals } from "./schema";
import type { StoreContext } from "./store-context";

/**
 * Goal persistence (PRD #421, #424): the `goals` rows and their `goal_holdings`
 * assignments. A goal owns its assigned-holding set, so create/update rewrite
 * the link rows atomically and delete removes both (explicit, not FK-cascade
 * reliant — the connection's foreign-key pragma is not assumed on).
 */
export interface GoalStore {
  /** All goals (optionally for one scope), each with its assigned asset ids; ordered by deadline. */
  readGoals: (scopeId?: string) => Promise<Goal[]>;
  createGoal: (goal: Goal) => Promise<void>;
  updateGoal: (goal: Goal) => Promise<void>;
  deleteGoal: (goalId: string) => Promise<void>;
}

export function createGoalStore(ctx: StoreContext): GoalStore {
  return {
    readGoals: (scopeId) => readGoals(ctx, scopeId),
    createGoal: (goal) => createGoal(ctx, goal),
    updateGoal: (goal) => updateGoal(ctx, goal),
    deleteGoal: (goalId) => deleteGoal(ctx, goalId),
  };
}

async function readGoals(ctx: StoreContext, scopeId?: string): Promise<Goal[]> {
  const rows = await ctx.db
    .select()
    .from(goals)
    .where(scopeId ? eq(goals.scopeId, scopeId) : undefined)
    .orderBy(asc(goals.deadline), asc(goals.id))
    .all();

  if (rows.length === 0) {
    return [];
  }

  const links = await ctx.db
    .select()
    .from(goalHoldings)
    .where(
      inArray(
        goalHoldings.goalId,
        rows.map((row) => row.id),
      ),
    )
    .all();

  const assetsByGoal = new Map<string, string[]>();
  for (const link of links) {
    const list = assetsByGoal.get(link.goalId) ?? [];
    list.push(link.assetId);
    assetsByGoal.set(link.goalId, list);
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    targetAmountMinor: row.targetAmountMinor,
    deadline: row.deadline,
    priority: row.priority,
    scopeId: row.scopeId,
    assetIds: assetsByGoal.get(row.id) ?? [],
  }));
}

async function createGoal(ctx: StoreContext, goal: Goal): Promise<void> {
  await ctx.transaction(async () => {
    await ctx.db
      .insert(goals)
      .values({
        id: goal.id,
        scopeId: goal.scopeId,
        name: goal.name,
        targetAmountMinor: goal.targetAmountMinor,
        deadline: goal.deadline,
        priority: goal.priority,
      })
      .run();
    await insertGoalHoldings(ctx, goal);
  });
}

async function updateGoal(ctx: StoreContext, goal: Goal): Promise<void> {
  await ctx.transaction(async () => {
    await ctx.db
      .update(goals)
      .set({
        name: goal.name,
        scopeId: goal.scopeId,
        targetAmountMinor: goal.targetAmountMinor,
        deadline: goal.deadline,
        priority: goal.priority,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(goals.id, goal.id))
      .run();
    await ctx.db.delete(goalHoldings).where(eq(goalHoldings.goalId, goal.id)).run();
    await insertGoalHoldings(ctx, goal);
  });
}

async function deleteGoal(ctx: StoreContext, goalId: string): Promise<void> {
  await ctx.transaction(async () => {
    await ctx.db.delete(goalHoldings).where(eq(goalHoldings.goalId, goalId)).run();
    await ctx.db.delete(goals).where(eq(goals.id, goalId)).run();
  });
}

async function insertGoalHoldings(ctx: StoreContext, goal: Goal): Promise<void> {
  if (goal.assetIds.length === 0) {
    return;
  }
  await ctx.db
    .insert(goalHoldings)
    .values(goal.assetIds.map((assetId) => ({ goalId: goal.id, assetId })))
    .run();
}
