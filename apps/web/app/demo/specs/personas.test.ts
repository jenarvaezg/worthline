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
    const store = await createInMemoryStore();
    await seedPersona(store, JOVEN_SPEC, AS_OF);

    const workspace = await store.workspace.readWorkspace();
    expect(workspace?.members.length).toBe(1);

    const result = await readDashboard(store);
    expect(result.needsOnboarding).toBe(false);
    expect(result.presentation?.headline.amountMinor ?? 0).toBeGreaterThan(0);
    expect(result.warnings.filter((w) => w.severity === "blocking")).toHaveLength(0);

    const byTier = new Map(result.pyramid.map((t) => [t.tier, t]));
    expect(byTier.get("cash")?.grossAssets.amountMinor ?? 0).toBeGreaterThan(0);
    // One small derived investment puts a little on the market rung.
    expect(byTier.get("market")?.grossAssets.amountMinor ?? 0).toBeGreaterThan(0);
    expect(byTier.get("term-locked")?.grossAssets.amountMinor ?? 0).toBeGreaterThan(0);
    expect(byTier.get("illiquid")?.grossAssets.amountMinor ?? 0).toBeGreaterThan(0);
    expect(await store.liabilities.readDebtModel("liability_joven_master")).toBe(
      "informal",
    );
    expect(
      await store.liabilities.readBalanceAnchors("liability_joven_master"),
    ).toHaveLength(3);

    store.close();
  });

  it("still shows the onboarding checklist (FIRE step pending)", async () => {
    const store = await createInMemoryStore();
    await seedPersona(store, JOVEN_SPEC, AS_OF);

    const result = await readDashboard(store);
    const fireStep = result.onboarding.find((s) => s.id === "fire");
    expect(fireStep?.done).toBe(false);
    expect(result.onboarding.some((s) => !s.done)).toBe(true);

    store.close();
  });
});

describe("seedPersona — inversor (markets-heavy)", () => {
  it("populates the market and term-locked rungs with a rich history", async () => {
    const store = await createInMemoryStore();
    await seedPersona(store, INVERSOR_SPEC, AS_OF);

    const result = await readDashboard(store);
    expect(result.needsOnboarding).toBe(false);
    expect(result.warnings.filter((w) => w.severity === "blocking")).toHaveLength(0);

    const byTier = new Map(result.pyramid.map((t) => [t.tier, t]));
    expect(byTier.get("market")?.grossAssets.amountMinor ?? 0).toBeGreaterThan(0);
    expect(byTier.get("term-locked")?.grossAssets.amountMinor ?? 0).toBeGreaterThan(0);

    // ~1–2 years of operations build a believable monthly curve.
    expect(
      (await store.snapshots.readSnapshots("household")).length,
    ).toBeGreaterThanOrEqual(12);

    store.close();
  }, 15_000);

  it("mirrors a frozen connected source with positions", async () => {
    const store = await createInMemoryStore();
    await seedPersona(store, INVERSOR_SPEC, AS_OF);

    const sources = await store.connectedSources.listSources();
    expect(sources.map((source) => source.adapter).sort()).toEqual([
      "binance",
      "numista",
    ]);

    const binance = sources.find((source) => source.adapter === "binance")!;
    const numista = sources.find((source) => source.adapter === "numista")!;
    expect(
      (await store.connectedSources.readPositions(binance.id)).some(
        (position) => position.kind === "token",
      ),
    ).toBe(true);
    expect(
      (await store.connectedSources.readPositions(numista.id)).some(
        (position) => position.kind === "coin",
      ),
    ).toBe(true);

    store.close();
  });

  it("backfills Binance value before today's open period", async () => {
    const store = await createInMemoryStore();
    await seedPersona(store, INVERSOR_SPEC, AS_OF);

    await readDashboard(store);

    const binance = (await store.connectedSources.listSources()).find(
      (source) => source.adapter === "binance",
    )!;
    const rows = await store.snapshots.readSnapshotHoldings({
      holdingId: binance.assetId,
      kind: "asset",
      scopeId: "household",
    });
    const mayClose = rows.find((row) => row.dateKey === "2026-05-31");
    const today = rows.find((row) => row.dateKey === AS_OF);

    expect(mayClose?.valueMinor ?? 0).toBeGreaterThan(0);
    expect(today?.valueMinor ?? 0).toBeGreaterThan(0);
    expect(Math.abs((today?.valueMinor ?? 0) - (mayClose?.valueMinor ?? 0))).toBeLessThan(
      5_000_00,
    );

    store.close();
  });

  it("computes strong FIRE progress for the configured scope", async () => {
    const store = await createInMemoryStore();
    await seedPersona(store, INVERSOR_SPEC, AS_OF);

    const result = await readDashboard(store, "household");
    expect(result.fireScopeConfig).not.toBeNull();
    expect(result.fireResult).not.toBeNull();
    expect(result.fireResult!.percentFunded).toBeGreaterThan(10);

    store.close();
  });
});
