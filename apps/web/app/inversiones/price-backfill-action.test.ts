/**
 * Historical-price backfill actions (#380, ADR 0033).
 *
 * The explicit "Rellenar histórico de precios" preview/confirm pair, mirroring
 * the statement upload (preview shows counts + source + gaps and WRITES NOTHING;
 * confirm applies and redirects). Plus a guard test that the daily refresh still
 * does NOT rewrite history — only this action does. Uses the `_store` injection
 * seam with a real in-memory store, an injected historical source stub, and a
 * fixed clock (no network, deterministic dates).
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { fixedClock } from "@worthline/domain";
import type { HistoricalPriceSource } from "@worthline/pricing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  confirmPriceBackfillAction,
  previewPriceBackfillAction,
  refreshPricesAction,
} from "./actions";

const NOW = "2026-03-15T10:00:00.000Z";

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "btc",
    liquidityTier: "market",
    name: "Bitcoin",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    priceProvider: "coingecko",
    providerSymbol: "bitcoin",
  });
  // A backdated buy → cost-basis snapshots (no price cached those days).
  await store.recordOperationAndRipple(
    {
      assetId: "btc",
      currency: "EUR",
      executedAt: "2026-01-10",
      feesMinor: 0,
      id: "op_jan",
      kind: "buy",
      pricePerUnit: "30000",
      units: "0.5",
    },
    { today: "2026-03-15" },
  );
}

/** A source that prices Feb but not Mar → one point, one gap. */
function stubSource(): HistoricalPriceSource {
  return {
    fetchSeriesEur: vi.fn(async () => ({
      pricesByDate: new Map([["2026-02-01", "40000"]]),
      source: "coingecko",
    })),
  };
}

function backfillForm(): FormData {
  const fd = new FormData();
  fd.set("currentUrl", "/patrimonio/btc/editar");
  return fd;
}

function refreshForm(): FormData {
  const fd = new FormData();
  fd.set("currentUrl", "/patrimonio");
  return fd;
}

describe("previewPriceBackfillAction (#380)", () => {
  test("returns counts + source + gaps and writes NOTHING", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const snapshotsBefore = (await store.snapshots.readSnapshots()).length;
    const febBefore = (
      await store.snapshots.readSnapshotHoldings({ holdingId: "btc", kind: "asset" })
    ).find((r) => r.dateKey === "2026-02-01");

    const state = await previewPriceBackfillAction(
      "btc",
      { status: "idle" },
      backfillForm(),
      store,
      stubSource(),
      fixedClock(NOW),
    );

    expect(state.status).toBe("summary");
    if (state.status !== "summary") throw new Error("expected summary");
    expect(state.source).toBe("coingecko");
    // One priced month (Feb) — and Feb's snapshot already exists (so it'd update)
    // but the seed only generated a snapshot at 2026-01-10, so Feb is a create.
    expect(state.create + state.update).toBeGreaterThanOrEqual(1);
    expect(state.gaps).toContain("2026-03-01");

    // Nothing was written: the snapshot count and the (absent) Feb row are unchanged.
    expect((await store.snapshots.readSnapshots()).length).toBe(snapshotsBefore);
    const febAfter = (
      await store.snapshots.readSnapshotHoldings({ holdingId: "btc", kind: "asset" })
    ).find((r) => r.dateKey === "2026-02-01");
    expect(febAfter).toEqual(febBefore);
    store.close();
  });

  test("reports a non-zero update count when a priced month already has a snapshot", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    // A second op ON the month-start so a 2026-02-01 snapshot already EXISTS at
    // cost basis before the backfill (snapshots land on operation dates) — pricing
    // it is an UPDATE, while later months are creates.
    await store.recordOperationAndRipple(
      {
        assetId: "btc",
        currency: "EUR",
        executedAt: "2026-02-01",
        feesMinor: 0,
        id: "op_feb",
        kind: "buy",
        pricePerUnit: "38000",
        units: "0.1",
      },
      { today: "2026-03-15" },
    );

    const updateSource: HistoricalPriceSource = {
      fetchSeriesEur: vi.fn(async () => ({
        pricesByDate: new Map([
          ["2026-02-01", "40000"], // existing snapshot → update
          ["2026-03-01", "50000"], // no snapshot → create
        ]),
        source: "coingecko",
      })),
    };

    const state = await previewPriceBackfillAction(
      "btc",
      { status: "idle" },
      backfillForm(),
      store,
      updateSource,
      fixedClock(NOW),
    );

    expect(state.status).toBe("summary");
    if (state.status !== "summary") throw new Error("expected summary");
    expect(state.update).toBeGreaterThanOrEqual(1);
    expect(state.create).toBeGreaterThanOrEqual(1);
    store.close();
  });

  test("reports a non-candidate (no provider symbol) without offering a backfill", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      name: "Fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    await store.recordOperationAndRipple(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2026-01-10",
        feesMinor: 0,
        id: "op",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: "2026-03-15" },
    );

    const state = await previewPriceBackfillAction(
      "fund",
      { status: "idle" },
      backfillForm(),
      store,
      stubSource(),
      fixedClock(NOW),
    );

    expect(state.status).toBe("not_eligible");
    store.close();
  });

  test("routes Yahoo investments to the Yahoo historical source by default", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "gold",
      liquidityTier: "market",
      name: "WisdomTree Physical Gold",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      priceProvider: "yahoo",
      providerSymbol: "GBSE.MI",
    });
    await store.recordOperationAndRipple(
      {
        assetId: "gold",
        currency: "EUR",
        executedAt: "2026-01-10",
        feesMinor: 0,
        id: "op_jan",
        kind: "buy",
        pricePerUnit: "18",
        units: "100",
      },
      { today: "2026-03-15" },
    );

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: { currency: "EUR" },
              timestamp: [Math.floor(Date.parse("2026-02-01T00:00:00.000Z") / 1000)],
              indicators: {
                quote: [{ close: [21.5] }],
              },
            },
          ],
        },
      }),
    } as Response);

    const fd = new FormData();
    fd.set("currentUrl", "/patrimonio/gold/editar");

    const state = await previewPriceBackfillAction(
      "gold",
      { status: "idle" },
      fd,
      store,
      fixedClock(NOW),
    );

    expect(state.status).toBe("summary");
    if (state.status !== "summary") throw new Error("expected summary");
    expect(state.source).toBe("yahoo");
    expect(state.create + state.update).toBeGreaterThanOrEqual(1);
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain(
      "/v8/finance/chart/GBSE.MI",
    );
    store.close();
    vi.unstubAllGlobals();
  });
});

describe("confirmPriceBackfillAction (#380)", () => {
  async function runConfirm(
    store: WorthlineStore,
    source: HistoricalPriceSource,
  ): Promise<string> {
    try {
      await confirmPriceBackfillAction(
        "btc",
        backfillForm(),
        store,
        source,
        fixedClock(NOW),
      );
      throw new Error("action did not redirect");
    } catch (err: unknown) {
      const e = err as { message?: string; digest?: string };
      if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") return e.digest;
      throw err;
    }
  }

  test("applies the backfill: the Feb row becomes units × price, gone is the cost line", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const digest = await runConfirm(store, stubSource());
    expect(digest).toContain("ok=");

    const feb = (
      await store.snapshots.readSnapshotHoldings({ holdingId: "btc", kind: "asset" })
    ).find((r) => r.dateKey === "2026-02-01");
    expect(feb?.valueMinor).toBe(0.5 * 40000 * 100);
    expect(feb?.unitPrice).toBe("40000");
    store.close();
  });
});

describe("daily refresh still does NOT rewrite history (#380 guard)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("refreshPricesAction leaves the cost-basis snapshots untouched", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const rowsBefore = (
      await store.snapshots.readSnapshotHoldings({ holdingId: "btc", kind: "asset" })
    ).map((r) => ({
      dateKey: r.dateKey,
      valueMinor: r.valueMinor,
      unitPrice: r.unitPrice,
    }));

    // A live quote arrives via the daily refresh — it must NOT ripple history.
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ bitcoin: { eur: 54979 } }),
    } as Response);

    try {
      await refreshPricesAction(refreshForm(), store, undefined, fixedClock(NOW));
    } catch (err: unknown) {
      const e = err as { message?: string };
      if (e.message !== "NEXT_REDIRECT") throw err;
    }

    const rowsAfter = (
      await store.snapshots.readSnapshotHoldings({ holdingId: "btc", kind: "asset" })
    ).map((r) => ({
      dateKey: r.dateKey,
      valueMinor: r.valueMinor,
      unitPrice: r.unitPrice,
    }));

    expect(rowsAfter).toEqual(rowsBefore);
    store.close();
  });
});
