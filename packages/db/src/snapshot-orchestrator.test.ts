/**
 * Snapshot-orchestration cross-cutting seams (issue #488): unit tests for the two
 * store methods extracted into `./snapshot-orchestrator` —
 * `backfillHistoricalSnapshots` (the one-shot gap-fill, ADR 0012 / PRD #107) and
 * `backfillInvestmentPricesAndRipple` (the historical-price backfill, ADR 0033 /
 * #380). Behavioral, through the public store (`createInMemoryStore` → record ops →
 * backfill → snapshot reads), mirroring the established src-local store-test style
 * (see connected-source-seams.test.ts). These guard that the factory wiring
 * (substituted snapshot/getWorkspace handles) preserves the seam behavior; the
 * deeper edge matrix lives in `tests/price-backfill-seam.persistence.test.ts` and
 * the snapshot-hardening persistence suites.
 */

import type { DecimalString } from "@worthline/domain";
import { describe, expect, it } from "vitest";
import type { PersistenceTestStore as WorthlineStore } from "./testing";
import { createInMemoryStore } from "./testing";

const TODAY = "2026-06-15";
const MEMBER_ID = "mJ";

async function seedIndividual(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "btc",
    liquidityTier: "market",
    name: "Bitcoin",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    priceProvider: "coingecko",
    providerSymbol: "bitcoin",
  });
}

/** A backdated sell recorded WITHOUT rippling (pure ledger persistence). */
async function recordSellNoRipple(
  store: WorthlineStore,
  executedAt: string,
  units: string,
  price: string,
): Promise<void> {
  await store.operations.recordOperation({
    assetId: "btc",
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id: `op_sell_${executedAt}_${units}`,
    kind: "sell",
    pricePerUnit: price,
    units,
  });
}

/** A backdated buy that ALSO ripples — lands a snapshot on its own date. */
async function recordBuy(
  store: WorthlineStore,
  executedAt: string,
  units: string,
  price: string,
): Promise<void> {
  await store.command.recordInvestmentOperation(
    {
      assetId: "btc",
      currency: "EUR",
      executedAt,
      feesMinor: 0,
      id: `op_${executedAt}_${units}`,
      kind: "buy",
      pricePerUnit: price,
      units,
    },
    { today: TODAY },
  );
}

/**
 * A backdated buy that does NOT ripple (pure persistence): the operation lands in
 * the ledger but no snapshot is generated for its date — exactly the gap that
 * `backfillHistoricalSnapshots` exists to fill.
 */
async function recordBuyNoRipple(
  store: WorthlineStore,
  executedAt: string,
  units: string,
  price: string,
): Promise<void> {
  await store.operations.recordOperation({
    assetId: "btc",
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id: `op_${executedAt}_${units}`,
    kind: "buy",
    pricePerUnit: price,
    units,
  });
}

async function snapshotDates(store: WorthlineStore): Promise<string[]> {
  return (await store.snapshots.readSnapshots())
    .map((snap) => snap.dateKey)
    .sort((a, b) => a.localeCompare(b));
}

async function rowAt(
  store: WorthlineStore,
  holdingId: string,
  dateKey: string,
): Promise<{ valueMinor: number; unitPrice?: string } | undefined> {
  return (await store.snapshots.readSnapshotHoldings({ holdingId, kind: "asset" })).find(
    (row) => row.dateKey === dateKey,
  );
}

describe("backfillHistoricalSnapshots — one-shot gap-fill (ADR 0012, PRD #107)", () => {
  it("generates a historical snapshot per past operation date that has none", async () => {
    const store = await createInMemoryStore();
    await seedIndividual(store);

    // Two past-dated buys recorded WITHOUT rippling → the ledger carries two event
    // dates but no snapshot exists on either: the genuine gap-fill case.
    await recordBuyNoRipple(store, "2026-01-10", "0.5", "30000");
    await recordBuyNoRipple(store, "2026-02-10", "0.5", "30000");
    expect(await snapshotDates(store)).toEqual([]);

    await store.command.backfillHistoricalSnapshots(TODAY);

    // Both past operation dates now carry a generated (individual) snapshot, valued
    // at cost basis (no price was cached on those days) — alongside the monthly
    // floor (#1444) of every month the position existed.
    expect(await snapshotDates(store)).toEqual([
      "2026-01-10",
      "2026-02-01",
      "2026-02-10",
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
    ]);
    expect((await rowAt(store, "btc", "2026-01-10"))?.valueMinor).toBe(0.5 * 30000 * 100);
    store.close();
  });

  it("is idempotent — a second backfill adds nothing", async () => {
    const store = await createInMemoryStore();
    await seedIndividual(store);
    await recordBuyNoRipple(store, "2026-01-10", "0.5", "30000");
    await recordBuyNoRipple(store, "2026-02-10", "0.5", "30000");

    await store.command.backfillHistoricalSnapshots(TODAY);
    const afterFirst = await snapshotDates(store);
    expect(afterFirst).toHaveLength(7); // 2 operation dates + 5 monthly-floor points

    await store.command.backfillHistoricalSnapshots(TODAY);
    expect(await snapshotDates(store)).toEqual(afterFirst);
    store.close();
  });

  it("never recalculates an existing snapshot — only gaps are filled", async () => {
    const store = await createInMemoryStore();
    await seedIndividual(store);

    // 2026-01-10 lands a real (rippled) snapshot; 2026-02-10 is recorded without
    // ripple, so only the February date is a gap.
    await recordBuy(store, "2026-01-10", "0.5", "30000");
    await recordBuyNoRipple(store, "2026-02-10", "0.5", "30000");

    const janBefore = await rowAt(store, "btc", "2026-01-10");
    expect(janBefore).toBeDefined();
    expect(await snapshotDates(store)).toEqual(["2026-01-10"]);

    await store.command.backfillHistoricalSnapshots(TODAY);

    // The February gap got filled; the pre-existing January snapshot is untouched.
    expect(await snapshotDates(store)).toEqual([
      "2026-01-10",
      "2026-02-01",
      "2026-02-10",
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
    ]);
    expect(await rowAt(store, "btc", "2026-01-10")).toEqual(janBefore);
    store.close();
  });
});

describe("backfillHistoricalSnapshots — the monthly floor (#1444)", () => {
  it("adds the 1st of every month with a position, on top of the operation dates", async () => {
    const store = await createInMemoryStore();
    await seedIndividual(store);

    // A busy March and four quiet months — the shape of the real workspace this
    // came from: the density measured trading, not time.
    await recordBuyNoRipple(store, "2026-01-10", "0.5", "30000");
    for (const day of ["03", "07", "11", "19"]) {
      await recordBuyNoRipple(store, `2026-03-${day}`, "0.1", "31000");
    }

    await store.command.backfillHistoricalSnapshots(TODAY);

    // Union: the five operation dates AND a 1st per month the position existed.
    // January's 1st predates the first buy, so it does not appear.
    expect(await snapshotDates(store)).toEqual([
      "2026-01-10",
      "2026-02-01",
      "2026-03-01",
      "2026-03-03",
      "2026-03-07",
      "2026-03-11",
      "2026-03-19",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
    ]);
    store.close();
  });

  it("never overwrites a 1st that already has a snapshot", async () => {
    const store = await createInMemoryStore();
    await seedIndividual(store);

    // A rippled buy ON 2026-03-01 lands a real snapshot there before any backfill.
    await recordBuy(store, "2026-01-10", "0.5", "30000");
    await recordBuy(store, "2026-03-01", "0.25", "45000");
    const marchBefore = await rowAt(store, "btc", "2026-03-01");
    expect(marchBefore).toBeDefined();

    await store.command.backfillHistoricalSnapshots(TODAY);

    expect(await rowAt(store, "btc", "2026-03-01")).toEqual(marchBefore);
    store.close();
  });

  it("invents no 1st for a month with nothing held, nor for today", async () => {
    const store = await createInMemoryStore();
    await seedIndividual(store);

    // Bought in January, sold out in February → March onwards holds nothing.
    await recordBuyNoRipple(store, "2026-01-10", "0.5", "30000");
    await recordSellNoRipple(store, "2026-02-20", "0.5", "34000");

    await store.command.backfillHistoricalSnapshots(TODAY);

    // Only February's 1st (the position was alive then) plus the buy date. March
    // onwards gets no floor, and the sell date holds nothing left to snapshot.
    expect(await snapshotDates(store)).toEqual(["2026-01-10", "2026-02-01"]);
    store.close();
  });

  it("stops before today — the daily capture owns it", async () => {
    const store = await createInMemoryStore();
    await seedIndividual(store);
    await recordBuyNoRipple(store, "2026-01-10", "0.5", "30000");

    // A today that IS a month-start: it must stay out of the floor.
    await store.command.backfillHistoricalSnapshots("2026-04-01");

    expect(await snapshotDates(store)).toEqual([
      "2026-01-10",
      "2026-02-01",
      "2026-03-01",
    ]);
    store.close();
  });
});

describe("backfillInvestmentPricesAndRipple — historical-price backfill (ADR 0033, #380)", () => {
  const prices = new Map<string, DecimalString>([
    ["2026-02-01", "40000"],
    ["2026-03-01", "50000"],
  ]);

  it("creates fresh priced snapshots at gap dates from the historical quote", async () => {
    const store = await createInMemoryStore();
    await seedIndividual(store);
    await recordBuy(store, "2026-01-10", "0.5", "30000");

    // No 2026-02-01 / 2026-03-01 snapshot exists until the backfill creates them.
    expect(await rowAt(store, "btc", "2026-02-01")).toBeUndefined();

    const result = await store.command.backfillInvestmentPrices({
      assetId: "btc",
      pricesByDate: prices,
      source: "coingecko",
      today: TODAY,
    });

    expect(result.source).toBe("coingecko");
    // Two priced months × 1 scope (individual) = 2 created, 0 updated.
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);

    const feb = await rowAt(store, "btc", "2026-02-01");
    expect(feb?.valueMinor).toBe(0.5 * 40000 * 100);
    expect(feb?.unitPrice).toBe("40000");
    const mar = await rowAt(store, "btc", "2026-03-01");
    expect(mar?.valueMinor).toBe(0.5 * 50000 * 100);
    expect(mar?.unitPrice).toBe("50000");
    store.close();
  });

  it("updates the asset's row on an existing snapshot (price frozen, value recomputed)", async () => {
    const store = await createInMemoryStore();
    await seedIndividual(store);
    // Two ops: the second ON 2026-03-01 lands a cost-basis snapshot there already.
    await recordBuy(store, "2026-01-10", "0.5", "30000");
    await recordBuy(store, "2026-03-01", "0.1", "48000");

    const marBefore = await rowAt(store, "btc", "2026-03-01");
    expect(marBefore?.unitPrice).toBeUndefined(); // at cost basis

    const result = await store.command.backfillInvestmentPrices({
      assetId: "btc",
      pricesByDate: new Map<string, DecimalString>([["2026-03-01", "50000"]]),
      source: "coingecko",
      today: TODAY,
    });

    // The existing 03-01 snapshot was updated in place, not recreated.
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    const marAfter = await rowAt(store, "btc", "2026-03-01");
    expect(marAfter?.unitPrice).toBe("50000");
    expect(marAfter?.valueMinor).toBe(0.6 * 50000 * 100); // 0.5 + 0.1 units priced
    store.close();
  });

  it("dryRun writes nothing but returns the same created/updated counts", async () => {
    const store = await createInMemoryStore();
    await seedIndividual(store);
    await recordBuy(store, "2026-01-10", "0.5", "30000");

    const preview = await store.command.backfillInvestmentPrices({
      assetId: "btc",
      dryRun: true,
      pricesByDate: prices,
      source: "coingecko",
      today: TODAY,
    });

    // Nothing was written: the gap months still have no snapshot.
    expect(await rowAt(store, "btc", "2026-02-01")).toBeUndefined();
    expect(await rowAt(store, "btc", "2026-03-01")).toBeUndefined();

    const confirm = await store.command.backfillInvestmentPrices({
      assetId: "btc",
      pricesByDate: prices,
      source: "coingecko",
      today: TODAY,
    });

    expect(preview.created).toBe(confirm.created);
    expect(preview.updated).toBe(confirm.updated);
    expect(preview.gaps).toEqual(confirm.gaps);
    // The confirm DID write: the rows now exist.
    expect(await rowAt(store, "btc", "2026-02-01")).toBeDefined();
    store.close();
  });
});
