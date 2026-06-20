/**
 * seedPersona integration tests (PRD #297, S1 #299).
 *
 * The seed builder is the deepest demo module: it must construct a coherent,
 * fictional workspace ENTIRELY through the store API + the dated-fact/ripple
 * seams (ADR 0020) — never by writing snapshot rows directly. These tests assert
 * the observable read model the dashboard sees, not the seed's internal calls.
 *
 * Prior art: e2e/global-setup.ts and tests/performance-harness-seeds.ts seed
 * through the same seams; load-dashboard.test.ts shows the read harness.
 */
import { describe, expect, it } from "vitest";

import { createInMemoryStore } from "@worthline/db";
import type { WorthlineStore } from "@worthline/db";

import { seedPersona } from "@web/demo/seed-persona";
import { FAMILIA_SPEC } from "@web/demo/specs/familia";
import { loadDashboard, type LoadDashboardInput } from "@web/load-dashboard";

const AS_OF = "2026-06-19";
const NOW_ISO = `${AS_OF}T12:00:00.000Z`;

const noOpRefresh: LoadDashboardInput["refreshPrices"] = async () => ({
  priceCache: [],
  errors: [],
});

function persistence() {
  return {
    status: "ok" as const,
    checkKey: "bootstrap.last_healthcheck_at",
    checkedAt: NOW_ISO,
    checkValue: NOW_ISO,
    databasePath: "/tmp/worthline-demo.sqlite",
    displayPath: "demo.sqlite",
  };
}

/** Load the dashboard read model for a scope, exactly as the page does. */
async function readDashboard(store: WorthlineStore, scopeId?: string) {
  return loadDashboard({
    store,
    persistence: persistence(),
    scopeId,
    selectedView: "total",
    today: AS_OF,
    now: NOW_ISO,
    refreshPrices: noOpRefresh,
  });
}

describe("seedPersona — familia", () => {
  it("builds a two-member household with the full scope axis", () => {
    const store = createInMemoryStore();
    seedPersona(store, FAMILIA_SPEC, AS_OF);

    const workspace = store.workspace.readWorkspace();
    expect(workspace).not.toBeNull();
    expect(workspace!.mode).toBe("household");
    expect(workspace!.members.length).toBe(2);

    store.close();
  });

  it("renders a populated net worth with no blocking warnings", async () => {
    const store = createInMemoryStore();
    seedPersona(store, FAMILIA_SPEC, AS_OF);

    const result = await readDashboard(store);

    expect(result.needsOnboarding).toBe(false);
    expect(result.presentation?.headline.amountMinor ?? 0).toBeGreaterThan(0);
    expect(result.warnings.filter((w) => w.severity === "blocking")).toHaveLength(0);

    store.close();
  });

  it("populates the housing rung and the illiquid rung (home + car)", async () => {
    const store = createInMemoryStore();
    seedPersona(store, FAMILIA_SPEC, AS_OF);

    const result = await readDashboard(store);
    const byTier = new Map(result.pyramid.map((t) => [t.tier, t]));

    // The home lands on the housing rung (ADR 0022) with positive gross value.
    expect(byTier.get("housing")?.grossAssets.amountMinor ?? 0).toBeGreaterThan(0);
    // Cash on hand and a car on the illiquid rung.
    expect(byTier.get("cash")?.grossAssets.amountMinor ?? 0).toBeGreaterThan(0);
    expect(byTier.get("illiquid")?.grossAssets.amountMinor ?? 0).toBeGreaterThan(0);
    // A mortgage shows as debt against the housing rung.
    expect(byTier.get("housing")?.debts.amountMinor ?? 0).toBeGreaterThan(0);

    store.close();
  });

  it("includes a non-mortgage anchored debt story", () => {
    const store = createInMemoryStore();
    seedPersona(store, FAMILIA_SPEC, AS_OF);

    expect(store.liabilities.readDebtModel("liability_familia_car")).toBe("informal");
    expect(store.liabilities.readBalanceAnchors("liability_familia_car")).toHaveLength(3);

    store.close();
  });

  it("generates a multi-month history via the ripple engine", async () => {
    const store = createInMemoryStore();
    seedPersona(store, FAMILIA_SPEC, AS_OF);

    // The mortgage plan + valuation anchors + backfill lay down a believable
    // monthly curve — not a single point. At least a year of monthly closes.
    const snapshots = store.snapshots.readSnapshots("household");
    expect(snapshots.length).toBeGreaterThanOrEqual(12);

    store.close();
  });

  it("computes FIRE progress for the configured household scope", async () => {
    const store = createInMemoryStore();
    seedPersona(store, FAMILIA_SPEC, AS_OF);

    const result = await readDashboard(store, "household");
    expect(result.fireScopeConfig).not.toBeNull();
    expect(result.fireResult).not.toBeNull();
    expect(result.fireResult!.percentFunded).toBeGreaterThan(0);

    store.close();
  });
});
