/**
 * Goal CRUD round-trip (PRD #421, #424): goals and their assigned holdings
 * persist through create / read / update / delete against a real SQLite database
 * migrated to the current schema version.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Goal } from "@worthline/domain";
import { describe, expect, it } from "vitest";

import { createWorthlineStoreUnsafe } from "./unsafe-store";

async function freshStore(): Promise<
  Awaited<ReturnType<typeof createWorthlineStoreUnsafe>>
> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "wl-goal-")), "w.sqlite");
  const store = await createWorthlineStoreUnsafe({ databasePath: dbPath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Uno" }],
    mode: "individual",
  });
  for (const id of ["a1", "a2"]) {
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1_000_00,
      id,
      liquidityTier: "cash",
      name: id,
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
      type: "cash",
    });
  }
  return store;
}

const carGoal: Goal = {
  id: "g1",
  name: "Coche",
  targetAmountMinor: 30_000_00,
  deadline: "2027-06-01",
  priority: "high",
  scopeId: "household",
  assetIds: ["a1", "a2"],
};

describe("goal CRUD", () => {
  it("creates a goal with assigned holdings and reads it back", async () => {
    const store = await freshStore();
    await store.goals.createGoal(carGoal);

    const goals = await store.goals.readGoals();
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({
      id: "g1",
      name: "Coche",
      targetAmountMinor: 30_000_00,
      deadline: "2027-06-01",
      priority: "high",
      scopeId: "household",
    });
    expect(goals[0]!.assetIds.sort()).toEqual(["a1", "a2"]);
  });

  it("updates a goal's fields and replaces its assigned holdings", async () => {
    const store = await freshStore();
    await store.goals.createGoal(carGoal);
    await store.goals.updateGoal({
      ...carGoal,
      name: "Coche eléctrico",
      targetAmountMinor: 35_000_00,
      priority: "medium",
      assetIds: ["a2"],
    });

    const goal = (await store.goals.readGoals())[0]!;
    expect(goal).toMatchObject({
      name: "Coche eléctrico",
      targetAmountMinor: 35_000_00,
      priority: "medium",
    });
    expect(goal.assetIds).toEqual(["a2"]);
  });

  it("deletes a goal and its holdings", async () => {
    const store = await freshStore();
    await store.goals.createGoal(carGoal);
    await store.goals.deleteGoal("g1");

    expect(await store.goals.readGoals()).toEqual([]);
  });

  it("filters by scope", async () => {
    const store = await freshStore();
    await store.goals.createGoal(carGoal);
    await store.goals.createGoal({
      ...carGoal,
      id: "g2",
      name: "Viaje",
      scopeId: "m1",
      assetIds: [],
    });

    expect((await store.goals.readGoals("household")).map((g) => g.id)).toEqual(["g1"]);
    expect((await store.goals.readGoals("m1")).map((g) => g.id)).toEqual(["g2"]);
    expect((await store.goals.readGoals()).map((g) => g.id).sort()).toEqual(["g1", "g2"]);
  });
});
