import type { PersistenceTestStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import type { ContributionPlan } from "@worthline/domain";
import { computeMonthlyContributionAllocation } from "@worthline/domain";
import { afterEach, describe, expect, test } from "vitest";

import { buildContributionPlanContext } from "./contribution-plan-context";
import type { ReadExposureCatalog } from "./exposure-catalog";
import { buildHoldingDetail } from "./holding-detail";
import { publicIdMap } from "./scope-resolution";
import { bindScope } from "./scoped-read";
import { listAgentViewScopes } from "./scopes";

const openStores = new Set<PersistenceTestStore>();
afterEach(() => {
  for (const store of openStores) store.close();
  openStores.clear();
});

const PLAN: ContributionPlan = {
  scopeId: "default",
  contributions: [
    {
      id: "c1",
      destinationHoldingId: "h1",
      amount: { mode: "money", value: 300_00 },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      startDate: "2026-01-01",
    },
  ],
};

// The MCP allocation reads the SAME seam /objetivos renders (PRD #553 S3) —
// this pins the builder's input contract to that shared derivation.
describe("contribution plan monthly allocation seam", () => {
  test("a monthly contribution yields one July occurrence in the allocation", () => {
    const allocation = computeMonthlyContributionAllocation({
      plan: PLAN,
      monthKey: "2026-07",
      today: "2026-07-05",
    });

    expect(allocation.monthKey).toBe("2026-07");
    expect(allocation.occurrenceCount).toBe(1);
    expect(allocation.totalPlannedMinor).toBe(300_00);
    expect(allocation.destinations).toEqual([
      {
        holdingId: "h1",
        occurrenceCount: 1,
        plannedMinor: 300_00,
        plannedUnits: null,
        executedMinor: 0,
        closedCount: 0,
      },
    ]);
  });

  test("an unpriced units destination is reported, never guessed or dropped", () => {
    const allocation = computeMonthlyContributionAllocation({
      plan: {
        scopeId: "default",
        contributions: [
          ...PLAN.contributions,
          {
            id: "c2",
            destinationHoldingId: "h2",
            amount: { mode: "units", value: "1" },
            cadence: { kind: "monthly", dayOfMonth: 1 },
            startDate: "2026-01-01",
          },
        ],
      },
      monthKey: "2026-07",
      today: "2026-07-05",
    });

    expect(allocation.unpricedHoldingIds).toEqual(["h2"]);
    expect(allocation.totalPlannedMinor).toBe(300_00);
    const unpriced = allocation.destinations.find((d) => d.holdingId === "h2");
    expect(unpriced?.plannedMinor).toBeNull();
    expect(unpriced?.plannedUnits).toBe("1");
  });
});

/**
 * #1627: the plan context measures a destination holding's own return through
 * `buildHoldingReturns`, the SAME fold the ficha rides — so it must fold the same
 * recorded payouts. While it did not, a distributing destination projected on a
 * rate the holding never earned, and the plan quoted a return the ficha of that
 * very holding contradicted (#1422).
 */
describe("el plan proyecta con los cobros del holding destino (#1627)", () => {
  const AS_OF = "2026-07-01";
  const CATALOG: ReadExposureCatalog = async () => ({
    status: "available",
    profiles: [],
  });

  async function seed(): Promise<PersistenceTestStore> {
    const store = await createInMemoryStore();
    openStores.add(store);
    await store.workspace.initializeWorkspace({
      members: [{ id: "m", name: "Titular" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "h1",
      instrument: "fund",
      name: "Fondo de reparto",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
    });
    await store.operations.recordOperation({
      assetId: "h1",
      currency: "EUR",
      executedAt: "2024-07-01T10:00:00.000Z",
      feesMinor: 0,
      id: "h1-op-0",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    });
    await store.contributionPlan.createPlannedContribution({
      // The household scope's internal id — the one the context binds to.
      scopeId: "household",
      destinationHoldingId: "h1",
      amount: { mode: "money", value: 100_00 },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      startDate: "2026-01-01",
    });
    return store;
  }

  async function trajectory(store: PersistenceTestStore): Promise<number[]> {
    const scopes = await listAgentViewScopes(store.agentView);
    const scope = scopes.find((candidate) => candidate.isDefault) ?? scopes[0];
    if (!scope) throw new Error("seed has no scope");
    const context = await buildContributionPlanContext(
      bindScope(store.agentView, scope.id),
      { asOf: AS_OF, readExposureCatalog: CATALOG },
    );
    const points = context.exposureDrift.trajectory.map(
      (point) => point.grossAssets.amountMinor,
    );
    if (points.length < 3) throw new Error("drift has no trajectory to read");
    return points;
  }

  async function driftAtHorizon(store: PersistenceTestStore): Promise<number> {
    return (await trajectory(store)).at(-1)!;
  }

  test("un dividendo registrado sube la trayectoria que el plan proyecta", async () => {
    const store = await seed();
    // Sin cobros el fondo va justo a coste: su IRR es 0, así que la trayectoria
    // solo crece con lo aportado.
    const withoutPayout = await driftAtHorizon(store);

    await store.payouts.createPayout({
      holdingId: "h1",
      dateISO: "2025-07-01",
      amountMinor: 20_000,
      note: "Dividendo",
    });
    const withPayout = await driftAtHorizon(store);

    expect(withPayout).toBeGreaterThan(withoutPayout);
  }, 15_000);

  test("la tasa que el plan usa es la que la ficha publica, cobros incluidos", async () => {
    const store = await seed();
    const publicId = publicIdMap(await store.agentView.readPublicIds(), "holding").get(
      "h1",
    );
    if (!publicId) throw new Error("seeded asset has no public id");
    const ficha = async () =>
      (
        await buildHoldingDetail(store.agentView, publicId, {
          readExposureCatalog: CATALOG,
        })
      ).returns;

    // Sin cobros: el fondo va a coste, su IRR es 0 y no hay TWR (sin cierres
    // mensuales), así que el plan proyecta plano — cada año suma solo lo aportado.
    const before = await ficha();
    expect(before?.timeWeighted.rate).toBeNull();
    expect(Number(before?.moneyWeighted.rate)).toBeCloseTo(0, 6);
    expect(yearOverYearGrowth(await trajectory(store))).toEqual("flat");

    await store.payouts.createPayout({
      holdingId: "h1",
      dateISO: "2025-07-01",
      amountMinor: 20_000,
      note: "Dividendo",
    });

    // Con el cobro la ficha declara que entra en el IRR — y el plan proyecta a esa
    // tasa, no a la de un fondo que nunca repartió.
    const after = await ficha();
    expect(after?.qualitySignals.map((signal) => signal.code)).toContain(
      "DISTRIBUTIONS_NOT_IN_TWR",
    );
    expect(Number(after?.moneyWeighted.rate)).toBeGreaterThan(0);
    expect(yearOverYearGrowth(await trajectory(store))).toEqual("compounding");
  }, 15_000);
});

/** Whether a trajectory grows by a constant amount (rate 0) or compounds. */
function yearOverYearGrowth(points: number[]): "flat" | "compounding" {
  const steps = points.slice(1).map((value, index) => value - points[index]!);
  const first = steps[0]!;
  return steps.every((step) => Math.abs(step - first) <= 1) ? "flat" : "compounding";
}
