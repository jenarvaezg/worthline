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
