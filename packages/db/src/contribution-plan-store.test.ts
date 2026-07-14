/**
 * Planned-contribution CRUD round-trip (ADR 0041, PRD #553 S1).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWorthlineStore } from "./index";

async function freshStore(): Promise<Awaited<ReturnType<typeof createWorthlineStore>>> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "wl-contrib-")), "w.sqlite");
  const store = await createWorthlineStore({ databasePath: dbPath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Uno" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 10_000_00,
    id: "h1",
    liquidityTier: "market",
    name: "Fund",
    ownership: [{ memberId: "m1", shareBps: 10_000 }],
    type: "investment",
  });
  return store;
}

describe("contribution plan CRUD", () => {
  it("creates money and units contributions and reads the scope plan back", async () => {
    const store = await freshStore();
    const money = await store.contributionPlan.createPlannedContribution({
      scopeId: "default",
      destinationHoldingId: "h1",
      amount: { mode: "money", value: 250_000 },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      startDate: "2025-01-01",
    });
    const units = await store.contributionPlan.createPlannedContribution({
      scopeId: "default",
      destinationHoldingId: "h1",
      amount: { mode: "units", value: "1.25" },
      cadence: { kind: "weekly", weekday: 1 },
      startDate: "2025-01-06",
      endDate: "2025-12-31",
    });

    expect(await store.contributionPlan.readContributionPlan("default")).toEqual({
      scopeId: "default",
      contributions: [
        {
          id: money.id,
          destinationHoldingId: "h1",
          amount: { mode: "money", value: 250_000 },
          cadence: { kind: "monthly", dayOfMonth: 1 },
          startDate: "2025-01-01",
        },
        {
          id: units.id,
          destinationHoldingId: "h1",
          amount: { mode: "units", value: "1.25" },
          cadence: { kind: "weekly", weekday: 1 },
          startDate: "2025-01-06",
          endDate: "2025-12-31",
        },
      ],
    });
  });

  it("updates and deletes a planned contribution", async () => {
    const store = await freshStore();
    const created = await store.contributionPlan.createPlannedContribution({
      scopeId: "default",
      destinationHoldingId: "h1",
      amount: { mode: "money", value: 100_000 },
      cadence: { kind: "monthly", dayOfMonth: 15 },
      startDate: "2025-02-01",
    });

    await store.contributionPlan.updatePlannedContribution(created.id, {
      amount: { mode: "money", value: 150_000 },
      endDate: "2025-06-30",
    });

    const updated = await store.contributionPlan.readContributionPlan("default");
    expect(updated.contributions[0]).toEqual({
      ...created,
      amount: { mode: "money", value: 150_000 },
      endDate: "2025-06-30",
    });

    await store.contributionPlan.deletePlannedContribution(created.id);
    expect(await store.contributionPlan.readContributionPlan("default")).toEqual({
      scopeId: "default",
      contributions: [],
    });
  });

  it("rejects negative money amounts", async () => {
    const store = await freshStore();
    await expect(
      store.contributionPlan.createPlannedContribution({
        scopeId: "default",
        destinationHoldingId: "h1",
        amount: { mode: "money", value: -100 },
        cadence: { kind: "monthly", dayOfMonth: 1 },
        startDate: "2025-01-01",
      }),
    ).rejects.toThrow(/positive integer minor-unit amount/);
  });

  it("rejects invalid dates and endDate before startDate", async () => {
    const store = await freshStore();
    await expect(
      store.contributionPlan.createPlannedContribution({
        scopeId: "default",
        destinationHoldingId: "h1",
        amount: { mode: "money", value: 100_000 },
        cadence: { kind: "monthly", dayOfMonth: 1 },
        startDate: "not-a-date",
      }),
    ).rejects.toThrow(/YYYY-MM-DD/);

    await expect(
      store.contributionPlan.createPlannedContribution({
        scopeId: "default",
        destinationHoldingId: "h1",
        amount: { mode: "money", value: 100_000 },
        cadence: { kind: "monthly", dayOfMonth: 32 },
        startDate: "2025-01-01",
      }),
    ).rejects.toThrow(/dayOfMonth must be between 1 and 31/);

    await expect(
      store.contributionPlan.createPlannedContribution({
        scopeId: "default",
        destinationHoldingId: "h1",
        amount: { mode: "money", value: 100_000 },
        cadence: { kind: "monthly", dayOfMonth: 1 },
        startDate: "2025-06-01",
        endDate: "2025-01-01",
      }),
    ).rejects.toThrow(/End date must be on or after start date/);
  });
});

describe("contribution occurrence reconciliation", () => {
  it("links several buys to one occurrence while an operation belongs to at most one", async () => {
    const store = await freshStore();
    const contribution = await store.contributionPlan.createPlannedContribution({
      scopeId: "default",
      destinationHoldingId: "h1",
      amount: { mode: "money", value: 100_000 },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      startDate: "2025-01-01",
    });
    for (const id of ["op-1", "op-2"]) {
      await store.command.recordInvestmentOperation(
        {
          id,
          assetId: "h1",
          kind: "buy",
          executedAt: "2025-01-02",
          units: "1",
          pricePerUnit: "500",
          currency: "EUR",
          feesMinor: 100,
        },
        { today: "2025-01-02" },
      );
    }
    const occurrenceId = `${contribution.id}:2025-01-01`;
    await store.contributionPlan.linkOperation({
      contributionId: contribution.id,
      occurrenceId,
      operationId: "op-1",
    });
    await store.contributionPlan.linkOperation({
      contributionId: contribution.id,
      occurrenceId,
      operationId: "op-2",
    });
    await store.contributionPlan.setOccurrenceState({
      contributionId: contribution.id,
      occurrenceId,
      state: "open",
    });

    expect(await store.contributionPlan.readReconciliations("default")).toEqual([
      { occurrenceId, state: "open", operationIds: ["op-1", "op-2"] },
    ]);

    const otherOccurrence = `${contribution.id}:2025-02-01`;
    await expect(
      store.contributionPlan.linkOperation({
        contributionId: contribution.id,
        occurrenceId: otherOccurrence,
        operationId: "op-1",
      }),
    ).rejects.toThrow(/already linked/i);
  });

  it("supports fulfilled, skipped, and stored-value execution without writing truth itself", async () => {
    const store = await freshStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 100_000,
      id: "cash",
      liquidityTier: "cash",
      name: "Cash",
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
      type: "cash",
    });
    const contribution = await store.contributionPlan.createPlannedContribution({
      scopeId: "default",
      destinationHoldingId: "cash",
      amount: { mode: "money", value: 100_000 },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      startDate: "2025-01-01",
    });
    const fulfilled = `${contribution.id}:2025-01-01`;
    const skipped = `${contribution.id}:2025-02-01`;
    await store.contributionPlan.setOccurrenceState({
      contributionId: contribution.id,
      occurrenceId: fulfilled,
      state: "fulfilled",
      storedExecutionMinor: 95_000,
    });
    await store.contributionPlan.setOccurrenceState({
      contributionId: contribution.id,
      occurrenceId: skipped,
      state: "skipped",
    });

    expect(await store.contributionPlan.readReconciliations("default")).toEqual([
      {
        occurrenceId: fulfilled,
        state: "fulfilled",
        operationIds: [],
        storedExecutionMinor: 95_000,
      },
      { occurrenceId: skipped, state: "skipped", operationIds: [] },
    ]);
  });

  it("rejects a syntactically valid date that the cadence never generates", async () => {
    const store = await freshStore();
    const contribution = await store.contributionPlan.createPlannedContribution({
      scopeId: "default",
      destinationHoldingId: "h1",
      amount: { mode: "money", value: 100_000 },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      startDate: "2025-01-01",
    });
    await expect(
      store.contributionPlan.setOccurrenceState({
        contributionId: contribution.id,
        occurrenceId: `${contribution.id}:2025-01-02`,
        state: "skipped",
      }),
    ).rejects.toThrow(/cadence/i);
  });

  it("rejects the stored-value path for a derived destination", async () => {
    const store = await freshStore();
    const contribution = await store.contributionPlan.createPlannedContribution({
      scopeId: "default",
      destinationHoldingId: "h1",
      amount: { mode: "money", value: 100_000 },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      startDate: "2025-01-01",
    });
    await expect(
      store.command.applyStoredContributionValue({
        contributionId: contribution.id,
        occurrenceId: `${contribution.id}:2025-01-01`,
        assetId: "h1",
        newValueMinor: 200_000,
        executedMinor: 100_000,
      }),
    ).rejects.toThrow(/stored-value/i);
  });

  it("round-trips plan declarations, closures, and links through workspace export", async () => {
    const store = await freshStore();
    const contribution = await store.contributionPlan.createPlannedContribution({
      scopeId: "default",
      destinationHoldingId: "h1",
      amount: { mode: "money", value: 100_000 },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      startDate: "2025-01-01",
    });
    await store.command.recordInvestmentOperation(
      {
        id: "exported-op",
        assetId: "h1",
        kind: "buy",
        executedAt: "2025-01-02",
        units: "1",
        pricePerUnit: "1000",
        currency: "EUR",
      },
      { today: "2025-01-02" },
    );
    const occurrenceId = `${contribution.id}:2025-01-01`;
    await store.contributionPlan.linkOperation({
      contributionId: contribution.id,
      occurrenceId,
      operationId: "exported-op",
    });
    await store.contributionPlan.setOccurrenceState({
      contributionId: contribution.id,
      occurrenceId,
      state: "fulfilled",
    });

    const exported = await store.workspace.exportWorkspace();
    expect(exported.contributionPlans[0]?.contributions[0]?.id).toBe(contribution.id);
    expect(exported.contributionReconciliations).toEqual([
      {
        contributionId: contribution.id,
        occurrenceId,
        state: "fulfilled",
        operationIds: ["exported-op"],
      },
    ]);

    await store.workspace.importWorkspace(exported);
    expect(await store.contributionPlan.readContributionPlan("default")).toEqual(
      exported.contributionPlans[0],
    );
    expect(await store.contributionPlan.readReconciliations("default")).toEqual([
      { occurrenceId, state: "fulfilled", operationIds: ["exported-op"] },
    ]);
  });
});
