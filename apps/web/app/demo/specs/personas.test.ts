/**
 * joven + inversor persona integration tests (S3 #301). Each seeds through the
 * shared builder and asserts the observable read model — the features the persona
 * is meant to showcase.
 */
import { describe, expect, it } from "vitest";

import { createInMemoryStore } from "@worthline/db";
import type { WorthlineStore } from "@worthline/db";

import { seedPersona } from "@web/demo/seed-persona";
import { JOVEN_SPEC } from "@web/demo/specs/joven";
import { INVERSOR_SPEC } from "@web/demo/specs/inversor";
import { loadDashboard, type LoadDashboardInput } from "@web/load-dashboard";

const AS_OF = "2026-06-19";
const NOW_ISO = `${AS_OF}T12:00:00.000Z`;

const noOpRefresh: LoadDashboardInput["refreshPrices"] = async () => ({
  priceCache: [],
  errors: [],
});

async function readDashboard(store: WorthlineStore, scopeId?: string) {
  return loadDashboard({
    store,
    persistence: {
      status: "ok",
      checkKey: "k",
      checkedAt: NOW_ISO,
      checkValue: NOW_ISO,
      databasePath: "/tmp/d.sqlite",
      displayPath: "d.sqlite",
    },
    scopeId,
    selectedView: "total",
    today: AS_OF,
    now: NOW_ISO,
    refreshPrices: noOpRefresh,
  });
}

describe("seedPersona — joven (starter saver)", () => {
  it("renders a modest, coherent starter portfolio with no blocking warnings", async () => {
    const store = createInMemoryStore();
    seedPersona(store, JOVEN_SPEC, AS_OF);

    const workspace = store.workspace.readWorkspace();
    expect(workspace?.members.length).toBe(1);

    const result = await readDashboard(store);
    expect(result.needsOnboarding).toBe(false);
    expect(result.presentation?.headline.amountMinor ?? 0).toBeGreaterThan(0);
    expect(result.warnings.filter((w) => w.severity === "blocking")).toHaveLength(0);

    const byTier = new Map(result.pyramid.map((t) => [t.tier, t]));
    expect(byTier.get("cash")?.grossAssets.amountMinor ?? 0).toBeGreaterThan(0);
    // One small derived investment puts a little on the market rung.
    expect(byTier.get("market")?.grossAssets.amountMinor ?? 0).toBeGreaterThan(0);

    store.close();
  });

  it("still shows the onboarding checklist (FIRE step pending)", async () => {
    const store = createInMemoryStore();
    seedPersona(store, JOVEN_SPEC, AS_OF);

    const result = await readDashboard(store);
    const fireStep = result.onboarding.find((s) => s.id === "fire");
    expect(fireStep?.done).toBe(false);
    expect(result.onboarding.some((s) => !s.done)).toBe(true);

    store.close();
  });
});

describe("seedPersona — inversor (markets-heavy)", () => {
  it("populates the market and term-locked rungs with a rich history", async () => {
    const store = createInMemoryStore();
    seedPersona(store, INVERSOR_SPEC, AS_OF);

    const result = await readDashboard(store);
    expect(result.needsOnboarding).toBe(false);
    expect(result.warnings.filter((w) => w.severity === "blocking")).toHaveLength(0);

    const byTier = new Map(result.pyramid.map((t) => [t.tier, t]));
    expect(byTier.get("market")?.grossAssets.amountMinor ?? 0).toBeGreaterThan(0);
    expect(byTier.get("term-locked")?.grossAssets.amountMinor ?? 0).toBeGreaterThan(0);

    // ~1–2 years of operations build a believable monthly curve.
    expect(store.snapshots.readSnapshots("household").length).toBeGreaterThanOrEqual(12);

    store.close();
  });

  it("mirrors a frozen connected source with positions", () => {
    const store = createInMemoryStore();
    seedPersona(store, INVERSOR_SPEC, AS_OF);

    const sources = store.connectedSources.listSources();
    expect(sources.length).toBeGreaterThanOrEqual(1);
    expect(store.connectedSources.readPositions(sources[0]!.id).length).toBeGreaterThan(
      0,
    );

    store.close();
  });

  it("computes strong FIRE progress for the configured scope", async () => {
    const store = createInMemoryStore();
    seedPersona(store, INVERSOR_SPEC, AS_OF);

    const result = await readDashboard(store, "household");
    expect(result.fireScopeConfig).not.toBeNull();
    expect(result.fireResult).not.toBeNull();
    expect(result.fireResult!.percentFunded).toBeGreaterThan(10);

    store.close();
  });
});
