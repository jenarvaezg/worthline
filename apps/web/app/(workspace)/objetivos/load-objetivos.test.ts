/**
 * Tests for the /objetivos load module (#1700).
 *
 * `loadObjetivos`: scope → everything the screen paints. Exercised through the
 * public interface against the in-memory store — the sibling of
 * load-patrimonio.test.ts.
 *
 * What is worth pinning here is precisely what used to be unreachable while the
 * derivation lived inside the page function:
 *
 * - the read is cache-only (no writes, no network),
 * - the assumptions island's initial draft is EXACTLY what the form preloads,
 * - the allowance's consumed figure counts a destination that is already in the
 *   papelera (#1509), which is the bug that made «pasado 2.127 €» a false claim,
 * - the allocation window and the exposure-drift trajectories only exist when
 *   there is a plan to walk.
 */

import type { PersistenceTestStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import type { LocalPersistenceStatus, Workspace } from "@worthline/domain";
import { listScopeOptions } from "@worthline/domain";
import { describe, expect, test, vi } from "vitest";

// The global exposure catalog lives on the control plane; without a URL the
// reader degrades to `[]` anyway, but mocking it keeps the test from depending
// on the ambient environment.
vi.mock("@web/read-exposure-catalog", () => ({
  readExposureProfilesFromCatalog: async () => [],
}));

import { loadObjetivos } from "./load-objetivos";

const TODAY = "2026-06-10";

const PERSISTENCE: LocalPersistenceStatus = {
  checkKey: "bootstrap.last_healthcheck_at",
  checkValue: "2026-06-10T00:00:00.000Z",
  checkedAt: "2026-06-10T00:00:00.000Z",
  databasePath: ":memory:",
  displayPath: ":memory:",
  status: "ok",
};

async function makeWorkspace(store: PersistenceTestStore): Promise<Workspace> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
  const workspace = await store.workspace.readWorkspace();
  if (!workspace) throw new Error("workspace not initialized");
  return workspace;
}

async function load(store: PersistenceTestStore) {
  const workspace = await makeWorkspace(store);
  const scopes = listScopeOptions(workspace);

  return loadObjetivos({
    persistence: PERSISTENCE,
    scopes,
    selectedScope: scopes[0],
    // The in-memory store is the same surface the page's store exposes; the
    // sibling read model does the same cast.
    store: store as never,
    today: TODAY,
    workspace,
  });
}

async function makeCashAsset(store: PersistenceTestStore): Promise<void> {
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 100_000_00,
    id: "asset_cash",
    liquidityTier: "cash",
    name: "Caja",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "cash",
  });
}

/** A pension plan with one contribution this calendar year — the cupo's subject. */
async function makePensionPlan(
  store: PersistenceTestStore,
  id: string,
  name: string,
): Promise<void> {
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id,
    instrument: "pension_plan",
    name,
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    providerSymbol: "N5394",
  });
  await store.operations.recordOperation({
    assetId: id,
    currency: "EUR",
    executedAt: `${TODAY}T10:00:00.000Z`,
    id: `op_${id}`,
    kind: "buy",
    pricePerUnit: "10",
    units: "65",
  });
}

describe("loadObjetivos — the read model of /objetivos", () => {
  test("an empty workspace loads without a plan, without allowances and without drift", async () => {
    const store = await createInMemoryStore();
    const result = await load(store);

    expect(result.assets).toEqual([]);
    expect(result.monthlyAllocations).toBeNull();
    expect(result.contributionProjection).not.toBeNull();
    expect(result.exposureDriftTrajectories).toBeNull();
    expect(result.derivedAllowances).toEqual([]);
    expect(result.goals).toEqual([]);
    // The window is served whether or not there is a plan: it is what the URL is
    // clamped against, and it always names four months around today.
    expect(result.allocationWindow).toEqual(["2026-05", "2026-06", "2026-07", "2026-08"]);
    expect(result.allocationDefaultMonth).toBe("2026-06");
  });

  test("the read performs NO write — the healthcheck value is the only thing touched", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeCashAsset(store);
    const scopes = listScopeOptions(await mustWorkspace(store));

    const before = await store.assets.readAssets();
    await loadObjetivos({
      persistence: PERSISTENCE,
      scopes,
      selectedScope: scopes[0],
      store: store as never,
      today: TODAY,
      workspace: await mustWorkspace(store),
    });

    expect(await store.assets.readAssets()).toEqual(before);
    expect((await store.readTrash()).assets).toEqual([]);
  });

  test("the assumptions draft mirrors the saved config, field by field (#1450, #1473)", async () => {
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);
    const scopes = listScopeOptions(workspace);
    await store.saveFireConfig(scopes[0]!.id, {
      immobilizedCountsAsFireCapital: false,
      monthlySavingsCapacityMinor: 150_000,
      monthlySpendingMinor: 200_000,
      monthlySpendingIncludesDebtService: true,
      safeWithdrawalRate: 0.035,
      targetRetirementAge: 52,
    });

    const result = await loadObjetivos({
      persistence: PERSISTENCE,
      scopes,
      selectedScope: scopes[0],
      store: store as never,
      today: TODAY,
      workspace,
    });

    // The island opens on exactly what the form paints — a divergence here is a
    // screen born believing it has unsaved changes.
    expect(result.savedDraft.monthlySavingsCapacity).toBe("1500");
    expect(result.savedDraft.monthlySpending).toBe("2000");
    expect(result.savedDraft.targetRetirementAge).toBe("52");
    expect(result.savedDraft.countImmobilized).toBe(false);
    expect(result.savedDraft.spendingIncludesDebtService).toBe("yes");
    expect(result.fireScopeConfig?.safeWithdrawalRate).toBe(0.035);
    // Both sides of the immobilized declaration travel to the client (#1473).
    expect(result.fireResult).not.toBeNull();
    expect(result.fireResultImmobilizedFlipped).not.toBeNull();
  });

  test("a plan turns on the allocation months and the drift trajectories (#557)", async () => {
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);
    const scopes = listScopeOptions(workspace);
    await makePensionPlan(store, "asset_pp", "Plan de pensiones");
    await store.contributionPlan.createPlannedContribution({
      amount: { mode: "money", value: 100_00 },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      destinationHoldingId: "asset_pp",
      scopeId: scopes[0]!.id,
      startDate: "2026-01-01",
    });

    const result = await loadObjetivos({
      persistence: PERSISTENCE,
      scopes,
      selectedScope: scopes[0],
      store: store as never,
      today: TODAY,
      workspace,
    });

    expect(result.monthlyAllocations).toHaveLength(4);
    expect(result.monthlyAllocations?.map((month) => month.monthKey)).toEqual(
      result.allocationWindow,
    );
    expect(result.exposureDriftTrajectories).not.toBeNull();
    expect(result.contributionOperations.map((op) => op.id)).toContain("op_asset_pp");
  });

  test("an allowance counts what a destination in the papelera consumed this year (#1509)", async () => {
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);
    const scopes = listScopeOptions(workspace);
    await makePensionPlan(store, "asset_pp_old", "Plan traspasado");
    await store.contributionAllowances.createContributionAllowance({
      annualCapMinor: 1_500_00,
      holdingIds: ["asset_pp_old"],
      label: "Planes de pensiones",
      scopeId: scopes[0]!.id,
    });
    // Traspasado: the plan is emptied and sent to the papelera — and its
    // contributions of this year have still consumed cupo.
    await store.assets.softDeleteAsset(
      "asset_pp_old",
      `${TODAY}T12:00:00.000Z`,
      "mis_entry",
    );

    const result = await loadObjetivos({
      persistence: PERSISTENCE,
      scopes,
      selectedScope: scopes[0],
      store: store as never,
      today: TODAY,
      workspace,
    });

    const allowance = result.derivedAllowances[0];
    expect(allowance).toBeDefined();
    const usage = result.allowanceUsageById.get(allowance!.id);
    expect(usage?.consumedMinor).toBe(650_00);
    // …and the trashed destination is still nameable, or the panel would call it
    // invisible.
    expect(result.holdingNameById.get("asset_pp_old")).toBe("Plan traspasado");
    expect(result.trashedHoldingIds.has("asset_pp_old")).toBe(true);
  });

  test("recorded payouts fill the passive-income lens (#658)", async () => {
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);
    const scopes = listScopeOptions(workspace);
    await makeCashAsset(store);
    await store.payouts.createPayout({
      amountMinor: 12_000_00,
      dateISO: "2026-03-01",
      holdingId: "asset_cash",
    });

    const result = await loadObjetivos({
      persistence: PERSISTENCE,
      scopes,
      selectedScope: scopes[0],
      store: store as never,
      today: TODAY,
      workspace,
    });

    expect(result.passiveIncome?.hasPayouts).toBe(true);
    expect(result.passiveIncome?.totalMinor).toBe(12_000_00);
    // No declared spending yet → no coverage claimed.
    expect(result.passiveIncome?.coverageRatio).toBeNull();
  });
});

async function mustWorkspace(store: PersistenceTestStore): Promise<Workspace> {
  const workspace = await store.workspace.readWorkspace();
  if (!workspace) throw new Error("workspace not initialized");
  return workspace;
}
