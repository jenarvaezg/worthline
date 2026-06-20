/**
 * Historical-price backfill apply seam (#380, ADR 0033).
 *
 * `backfillInvestmentPricesAndRipple` is the ONLY new path that writes historical
 * `unit_price`. It is atomic (one transaction), explicit (never a refresh side
 * effect), and ADR-0012/0008-faithful: it re-values ONLY the backfilled asset's
 * row on each monthly date (units × historical price) and preserves every OTHER
 * frozen row verbatim — it never recalculates them from live identities. These
 * tests exercise the seam directly at the store with an injected `today`,
 * mirroring `operation-seam.persistence.test.ts`.
 */
import { describe, expect, test } from "vitest";

import { multiplyToMinor } from "@worthline/domain";

import { createInMemoryStore } from "@db/index";
import type { WorthlineStore } from "@db/index";

const TODAY = "2026-03-15";

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  // The backfilled crypto investment, priced from CoinGecko.
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "btc",
    liquidityTier: "market",
    name: "Bitcoin",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    priceProvider: "coingecko",
    providerSymbol: "bitcoin",
  });
  // A cash asset whose frozen rows must survive the backfill untouched.
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 1_000_00,
    id: "cash",
    liquidityTier: "cash",
    name: "Cuenta",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "cash",
  });
}

/** A scope's frozen rows for one asset on one date, sorted by date. */
async function rowsFor(store: WorthlineStore, holdingId: string) {
  return (await store.snapshots.readSnapshotHoldings({ holdingId, kind: "asset" })).sort(
    (a, b) => a.dateKey.localeCompare(b.dateKey),
  );
}

async function rowAt(store: WorthlineStore, holdingId: string, dateKey: string) {
  return (await rowsFor(store, holdingId)).find((r) => r.dateKey === dateKey);
}

describe("backfillInvestmentPricesAndRipple (#380)", () => {
  test("re-values the backfilled asset at units × price each month (no cost→price jump)", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    // A backdated buy: 0.5 BTC at 30.000 EUR on 2026-01-10. No price was cached
    // those days, so every generated snapshot is frozen at COST BASIS.
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
      { today: TODAY },
    );

    // Before backfill: the 02-01 row (an existing snapshot) is at cost — 0.5 ×
    // 30.000 = 15.000, with NO frozen unit price.
    const before = await rowAt(store, "btc", "2026-01-10");
    expect(before?.valueMinor).toBe(0.5 * 30000 * 100);
    expect(before?.unitPrice).toBeUndefined();

    // Apply the backfill with monthly historical prices.
    const result = await store.backfillInvestmentPricesAndRipple({
      assetId: "btc",
      pricesByDate: new Map([
        ["2026-01-01", "29000"], // before the op → no position, skipped
        ["2026-02-01", "40000"],
        ["2026-03-01", "50000"],
      ]),
      source: "coingecko",
      today: TODAY,
    });

    expect(result.source).toBe("coingecko");

    // The backfilled monthly rows are valued at units × price with a frozen price.
    const feb = await rowAt(store, "btc", "2026-02-01");
    expect(feb?.valueMinor).toBe(0.5 * 40000 * 100);
    expect(feb?.unitPrice).toBe("40000");
    expect(feb?.units).toBe("0.5");

    const mar = await rowAt(store, "btc", "2026-03-01");
    expect(mar?.valueMinor).toBe(0.5 * 50000 * 100);
    expect(mar?.unitPrice).toBe("50000");

    // The cost→price jump is gone: consecutive monthly values rise smoothly with
    // the price, not by a single-day +X leap from cost to the first live quote.
    const janVal = (await rowAt(store, "btc", "2026-01-10"))?.valueMinor ?? 0;
    const febVal = feb?.valueMinor ?? 0;
    // Jan is still cost basis (no price for 2026-01-10 exactly), Feb is priced —
    // but the chart now has the priced Feb/Mar months instead of a flat cost line
    // jumping only on the day the live price arrived.
    expect(febVal).toBeGreaterThan(janVal);
    store.close();
  });

  test("preserves OTHER frozen rows verbatim (cash row untouched)", async () => {
    const store = await createInMemoryStore();
    await seed(store);

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
      { today: TODAY },
    );

    const cashBefore = (await rowsFor(store, "cash")).map((r) => ({
      dateKey: r.dateKey,
      valueMinor: r.valueMinor,
    }));

    await store.backfillInvestmentPricesAndRipple({
      assetId: "btc",
      pricesByDate: new Map([
        ["2026-02-01", "40000"],
        ["2026-03-01", "50000"],
      ]),
      source: "coingecko",
      today: TODAY,
    });

    const cashAfter = (await rowsFor(store, "cash")).map((r) => ({
      dateKey: r.dateKey,
      valueMinor: r.valueMinor,
    }));

    // Every cash row that existed before is unchanged; the cash row's value is
    // never recalculated from the live identity (ADR 0008/0012).
    for (const before of cashBefore) {
      const after = cashAfter.find((r) => r.dateKey === before.dateKey);
      expect(after?.valueMinor).toBe(before.valueMinor);
    }
    store.close();
  });

  test("keeps the reconciliation invariant (asset rows sum to gross_assets)", async () => {
    const store = await createInMemoryStore();
    await seed(store);

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
      { today: TODAY },
    );

    await store.backfillInvestmentPricesAndRipple({
      assetId: "btc",
      pricesByDate: new Map([
        ["2026-02-01", "40000"],
        ["2026-03-01", "50000"],
      ]),
      source: "coingecko",
      today: TODAY,
    });

    // For every snapshot, the asset rows sum exactly to gross_assets_minor.
    for (const snapshot of await store.snapshots.readSnapshots()) {
      const rows = (
        await store.snapshots.readSnapshotHoldings({ scopeId: snapshot.scopeId })
      ).filter((r) => r.dateKey === snapshot.dateKey && r.kind === "asset");
      const sum = rows.reduce((acc, r) => acc + r.valueMinor, 0);
      expect(sum).toBe(snapshot.grossAssets.amountMinor);
    }
    store.close();
  });

  test("creates a missing monthly snapshot where a position existed but none was captured", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    // A single op on 2026-01-10 generates a snapshot on 2026-01-10 only — there
    // is no 2026-02-01 or 2026-03-01 snapshot until the backfill creates them.
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
      { today: TODAY },
    );

    expect(await rowAt(store, "btc", "2026-02-01")).toBeUndefined();

    const result = await store.backfillInvestmentPricesAndRipple({
      assetId: "btc",
      pricesByDate: new Map([
        ["2026-02-01", "40000"],
        ["2026-03-01", "50000"],
      ]),
      source: "coingecko",
      today: TODAY,
    });

    expect(result.created).toBeGreaterThanOrEqual(1);
    expect((await rowAt(store, "btc", "2026-02-01"))?.valueMinor).toBe(0.5 * 40000 * 100);
    store.close();
  });

  test("a month with no price is a gap, not a fabricated point", async () => {
    const store = await createInMemoryStore();
    await seed(store);

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
      { today: TODAY },
    );

    const result = await store.backfillInvestmentPricesAndRipple({
      assetId: "btc",
      pricesByDate: new Map([["2026-02-01", "40000"]]), // 03-01 missing
      source: "coingecko",
      today: TODAY,
    });

    expect(result.gaps).toContain("2026-03-01");
    // 03-01 was never priced → if no snapshot existed there, none is created.
    const mar = await rowAt(store, "btc", "2026-03-01");
    if (mar) {
      // If a snapshot existed (it doesn't here), it would stay at cost basis.
      expect(mar.unitPrice).toBeUndefined();
    } else {
      expect(mar).toBeUndefined();
    }
    store.close();
  });

  test("removes the cost→price cliff: every intermediate month carries a frozen price after backfill, and month-to-month deltas come ONLY from price moves (#380 AC contrast)", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    // Backdated buy on 2026-01-10. With no cached prices, every snapshot generated
    // between the op and today is frozen at COST BASIS (units, no unit price), so
    // the only re-pricing event is the day a live quote first arrives — a cliff.
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
      { today: TODAY },
    );

    // BEFORE: the existing intermediate row (the op's own date) is at cost — there
    // is no frozen unit price, so the chart would leap when the first quote lands.
    expect((await rowAt(store, "btc", "2026-01-10"))?.unitPrice).toBeUndefined();

    // A MONOTONIC monthly series (so toBeGreaterThan can never be the proof).
    const prices = new Map([
      ["2026-02-01", "40000"],
      ["2026-03-01", "50000"],
    ]);
    await store.backfillInvestmentPricesAndRipple({
      assetId: "btc",
      pricesByDate: prices,
      source: "coingecko",
      today: TODAY,
    });

    // AFTER: every backfilled month carries a non-undefined frozen unit price.
    const feb = await rowAt(store, "btc", "2026-02-01");
    const mar = await rowAt(store, "btc", "2026-03-01");
    expect(feb?.unitPrice).toBe("40000");
    expect(mar?.unitPrice).toBe("50000");

    // The Feb→Mar value delta equals EXACTLY units × (price[mar] − price[feb]) —
    // i.e. it is a price move, not a cost→price re-basing jammed onto one date.
    const units = 0.5;
    const expectedDelta =
      multiplyToMinor(String(units), "50000") - multiplyToMinor(String(units), "40000");
    expect((mar?.valueMinor ?? 0) - (feb?.valueMinor ?? 0)).toBe(expectedDelta);
    store.close();
  });

  test("a sell to exactly 0 units fabricates no priced snapshot for sold-out months", async () => {
    const store = await createInMemoryStore();
    await seed(store);

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
      { today: TODAY },
    );
    // Sell ALL units on 2026-02-20 → 0 held from then on.
    await store.recordOperationAndRipple(
      {
        assetId: "btc",
        currency: "EUR",
        executedAt: "2026-02-20",
        feesMinor: 0,
        id: "op_sell",
        kind: "sell",
        pricePerUnit: "45000",
        units: "0.5",
      },
      { today: TODAY },
    );

    const marBefore = await rowAt(store, "btc", "2026-03-01");

    await store.backfillInvestmentPricesAndRipple({
      assetId: "btc",
      pricesByDate: new Map([
        ["2026-02-01", "40000"], // units held → priced
        ["2026-03-01", "50000"], // fully sold by 02-20 → no units → must be skipped
      ]),
      source: "coingecko",
      today: TODAY,
    });

    // 02-01 is priced (units were held that month).
    expect((await rowAt(store, "btc", "2026-02-01"))?.unitPrice).toBe("40000");
    // 03-01 is never a backfill point: no spurious priced 0-unit row appears, and
    // any pre-existing row is byte-identical (the plan skipped the sold-out month).
    const marAfter = await rowAt(store, "btc", "2026-03-01");
    expect(marAfter).toEqual(marBefore);
    if (marAfter) expect(marAfter.unitPrice).toBeUndefined();
    store.close();
  });

  test("an empty pricesByDate is a no-op: zero created/updated, every row byte-identical, gaps list the held months", async () => {
    const store = await createInMemoryStore();
    await seed(store);

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
      { today: TODAY },
    );

    const btcBefore = await rowsFor(store, "btc");
    const cashBefore = await rowsFor(store, "cash");

    const result = await store.backfillInvestmentPricesAndRipple({
      assetId: "btc",
      pricesByDate: new Map(), // the unmapped-symbol / outage path: nothing to apply
      source: "coingecko",
      today: TODAY,
    });

    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    // Every position-bearing month is a gap (no price), never invented.
    expect(result.gaps).toContain("2026-02-01");
    expect(result.gaps).toContain("2026-03-01");
    // No row was touched.
    expect(await rowsFor(store, "btc")).toEqual(btcBefore);
    expect(await rowsFor(store, "cash")).toEqual(cashBefore);
    store.close();
  });

  test("an EXISTING cost-basis snapshot on a gap month stays at cost (unit price undefined), and the month is a gap", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    // Two backdated ops, the second on 2026-03-05, so a 2026-03-01 month-start
    // snapshot already exists AT COST BASIS before any backfill runs.
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
      { today: TODAY },
    );
    // A second op ON the month-start so a 2026-03-01 snapshot already exists at
    // cost basis (snapshots land on operation dates; an op mid-month would not).
    await store.recordOperationAndRipple(
      {
        assetId: "btc",
        currency: "EUR",
        executedAt: "2026-03-01",
        feesMinor: 0,
        id: "op_mar",
        kind: "buy",
        pricePerUnit: "48000",
        units: "0.1",
      },
      { today: TODAY },
    );

    const marBefore = await rowAt(store, "btc", "2026-03-01");
    expect(marBefore).toBeDefined();
    expect(marBefore?.unitPrice).toBeUndefined(); // at cost basis

    const result = await store.backfillInvestmentPricesAndRipple({
      assetId: "btc",
      pricesByDate: new Map([["2026-02-01", "40000"]]), // 03-01 deliberately omitted
      source: "coingecko",
      today: TODAY,
    });

    // 03-01 is a gap (no price), and its pre-existing cost-basis row is preserved.
    expect(result.gaps).toContain("2026-03-01");
    const marAfter = await rowAt(store, "btc", "2026-03-01");
    expect(marAfter?.unitPrice).toBeUndefined();
    expect(marAfter?.valueMinor).toBe(marBefore?.valueMinor);
    store.close();
  });

  test("stores exact decimal precision for a realistic non-round position", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    // The issue's own numbers: 0.259249 BTC, priced at 54979 EUR.
    const units = "0.259249";
    const price = "54979";
    await store.recordOperationAndRipple(
      {
        assetId: "btc",
        currency: "EUR",
        executedAt: "2026-01-10",
        feesMinor: 0,
        id: "op_jan",
        kind: "buy",
        pricePerUnit: "30000",
        units,
      },
      { today: TODAY },
    );

    await store.backfillInvestmentPricesAndRipple({
      assetId: "btc",
      pricesByDate: new Map([["2026-02-01", price]]),
      source: "coingecko",
      today: TODAY,
    });

    const feb = await rowAt(store, "btc", "2026-02-01");
    expect(feb?.units).toBe(units);
    expect(feb?.unitPrice).toBe(price);
    expect(feb?.valueMinor).toBe(multiplyToMinor(units, price));
    store.close();
  });

  test("dry run returns the same per-scope counts the apply writes, in HOUSEHOLD mode (preview === confirm)", async () => {
    // A 2-member household: listScopeOptions = household + 2 members = 3 scopes, so
    // each priced month writes 3 snapshots. A scope-agnostic plan count would say
    // 1 per month; the dry run must report the per-scope total the apply produces.
    const dry = await createInMemoryStore();
    await dry.workspace.initializeWorkspace({
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
      ],
      mode: "household",
    });
    await dry.assets.createInvestmentAsset({
      currency: "EUR",
      id: "btc",
      liquidityTier: "market",
      name: "Bitcoin",
      ownership: [
        { memberId: "mJ", shareBps: 5_000 },
        { memberId: "mA", shareBps: 5_000 },
      ],
      priceProvider: "coingecko",
      providerSymbol: "bitcoin",
    });
    await dry.recordOperationAndRipple(
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
      { today: TODAY },
    );

    const prices = new Map([
      ["2026-02-01", "40000"],
      ["2026-03-01", "50000"],
    ]);

    const preview = await dry.backfillInvestmentPricesAndRipple({
      assetId: "btc",
      dryRun: true,
      pricesByDate: prices,
      source: "coingecko",
      today: TODAY,
    });

    // The dry run wrote nothing: the new months still have no snapshot.
    expect(
      (
        await dry.snapshots.readSnapshotHoldings({ holdingId: "btc", kind: "asset" })
      ).some((r) => r.dateKey === "2026-02-01"),
    ).toBe(false);

    const confirm = await dry.backfillInvestmentPricesAndRipple({
      assetId: "btc",
      pricesByDate: prices,
      source: "coingecko",
      today: TODAY,
    });

    expect(preview.created).toBe(confirm.created);
    expect(preview.updated).toBe(confirm.updated);
    expect(preview.gaps).toEqual(confirm.gaps);
    // 2 priced months × 3 scopes (household + 2 members) = 6 created.
    expect(confirm.created).toBe(6);
    dry.close();
  });
});
