/**
 * Binance monthly-history backfill into snapshot history (PRD #245, S5 / #250,
 * ADR 0021).
 *
 * Integration tests against a real in-memory store. The reconstructed
 * `BinanceHistoryCurve` (balance step function × daily price) is FROZEN into
 * snapshots at backfill time — like the coin acquisition path, but SET (not
 * additive): the market holding's row at each affected date is set to
 * `binanceValueAtDate`, the snapshot generated if absent. The change is
 * append-only/frozen — a date whose snapshot already carries the binance row is
 * skipped — so re-syncing only adds newly-completed months and never rewrites a
 * past value. The current (partial) month is never materialized.
 */

import type { WorthlineStore } from "@db/index";
import { createInMemoryStore } from "@db/index";
import type { BinanceHistoryCurve, DecimalString } from "@worthline/domain";
import { describe, expect, test } from "vitest";

const TODAY = "2026-06-15";
const MEMBER_ID = "mJ";

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    liquidityTier: "market",
    name: "Fondo indexado",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
}

async function connectBinance(
  store: WorthlineStore,
): Promise<{ sourceId: string; assetId: string }> {
  return await store.connectedSources.connect({
    adapter: "binance",
    label: "Binance",
    credentialsJson: JSON.stringify({ apiKey: "KEY", apiSecret: "SECRET" }),
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
}

/** A backdated buy that GENERATES the snapshot at its date (the no-price fund
 *  freezes at cost basis), so the backfill has an existing snapshot to set into. */
async function recordBuy(
  store: WorthlineStore,
  executedAt: string,
  units: string,
  price: string,
): Promise<void> {
  await store.recordOperationAndRipple(
    {
      assetId: "fund",
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
 * A curve from per-month BTC balances + per-date BTC prices (one symbol is
 * enough to exercise the valuation rule: balance held across a month × daily
 * price). Months default a month-end price so every completed month is valuable.
 */
function curveOf(input: {
  monthEndBalances: Record<string, DecimalString>;
  dailyPrices: Record<string, DecimalString>;
}): BinanceHistoryCurve {
  const monthEnd = new Map<string, DecimalString>(Object.entries(input.monthEndBalances));
  const daily = new Map<string, DecimalString>(Object.entries(input.dailyPrices));
  return {
    monthEndBalances: new Map([["BTC", monthEnd]]),
    dailyPriceBySymbol: new Map([["BTC", daily]]),
  };
}

async function grossAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey)
    ?.grossAssets.amountMinor;
}

async function dateKeys(store: WorthlineStore): Promise<string[]> {
  return (await store.snapshots.readSnapshots()).map((snap) => snap.dateKey).sort();
}

describe("applyBinanceHistoryAndRipple backfills monthly history into snapshots", () => {
  test("generates a monthly-close snapshot at each completed month-end with the binance value", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId } = await connectBinance(store);

    // 1 BTC at month-end through 2026-03 and 2026-04, priced 100 (× 100 minor).
    await store.applyBinanceHistoryAndRipple({
      sourceId,
      curve: curveOf({
        monthEndBalances: { "2026-03": "1", "2026-04": "1" },
        dailyPrices: { "2026-03-31": "100", "2026-04-30": "100" },
      }),
      today: TODAY,
    });

    // The two completed months are generated at their last calendar day, valued
    // balance × that-day price = 1 × 100 = 100.00.
    expect(await grossAt(store, "2026-03-31")).toBe(100_00);
    expect(await grossAt(store, "2026-04-30")).toBe(100_00);
    store.close();
  });

  test("an EXISTING snapshot in the window gets the binance value added (additive to that date)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    // A pre-existing snapshot from a fund buy on a month-end date.
    await recordBuy(store, "2026-03-31", "10", "100"); // fund cost basis 1000.00
    expect(await grossAt(store, "2026-03-31")).toBe(1_000_00);

    const { sourceId } = await connectBinance(store);
    await store.applyBinanceHistoryAndRipple({
      sourceId,
      curve: curveOf({
        monthEndBalances: { "2026-03": "1" },
        dailyPrices: { "2026-03-31": "100" },
      }),
      today: TODAY,
    });

    // The fund row is preserved; the binance row (100) is set on top.
    expect(await grossAt(store, "2026-03-31")).toBe(1_000_00 + 100_00);
    store.close();
  });

  test("the current (partial) month is never materialized", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId } = await connectBinance(store);

    // 2026-06 is TODAY's month → not a completed month → never an anchor.
    await store.applyBinanceHistoryAndRipple({
      sourceId,
      curve: curveOf({
        monthEndBalances: { "2026-05": "1", "2026-06": "1" },
        dailyPrices: { "2026-05-31": "100", "2026-06-30": "100" },
      }),
      today: TODAY,
    });

    expect(await grossAt(store, "2026-05-31")).toBe(100_00);
    expect(await grossAt(store, "2026-06-30")).toBeUndefined();
    store.close();
  });

  test("a second call is a no-op for covered dates and only adds a newly-completed month (frozen/append-only)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId } = await connectBinance(store);

    // First sync covers 2026-03 only.
    await store.applyBinanceHistoryAndRipple({
      sourceId,
      curve: curveOf({
        monthEndBalances: { "2026-03": "1" },
        dailyPrices: { "2026-03-31": "100" },
      }),
      today: TODAY,
    });
    expect(await grossAt(store, "2026-03-31")).toBe(100_00);

    // Second sync: 2026-03 at a HIGHER value (a later price move) + a new 2026-04.
    await store.applyBinanceHistoryAndRipple({
      sourceId,
      curve: curveOf({
        monthEndBalances: { "2026-03": "1", "2026-04": "1" },
        dailyPrices: { "2026-03-31": "999", "2026-04-30": "100" },
      }),
      today: TODAY,
    });

    // 2026-03 stays frozen at its first value (its row already existed → skipped),
    // never rewritten to 999. 2026-04 is the newly-completed month, set fresh.
    expect(await grossAt(store, "2026-03-31")).toBe(100_00);
    expect(await grossAt(store, "2026-04-30")).toBe(100_00);
    store.close();
  });

  test("a completed month-end BELOW the curve start never materializes a spurious zero row (#250)", async () => {
    // The bug: a completed month-end (2026-02-28) that sits BELOW the curve's first
    // valuable day (binanceCurveStartDate = 2026-04-30, because 2026-02 has a balance
    // but NO priced day) used to anchor a zero-valued binance row whenever another
    // holding already had a snapshot on that earlier month-end — dragging the UI
    // "Datos desde" before the true start. The fix lower-bounds month-ends by `start`.
    const store = await createInMemoryStore();
    await seed(store);

    // A NON-binance holding with an existing snapshot on the earlier month-end.
    await recordBuy(store, "2026-02-28", "10", "100"); // fund cost basis 1000.00
    expect(await grossAt(store, "2026-02-28")).toBe(1_000_00);

    const { sourceId, assetId } = await connectBinance(store);

    // 2026-02 has a balance but NO price → unvaluable; 2026-04 has both → the curve's
    // first valuable day (and "Datos desde" basis) is 2026-04-30.
    const curve = curveOf({
      monthEndBalances: { "2026-02": "1", "2026-04": "1" },
      dailyPrices: { "2026-04-30": "100" },
    });

    await store.applyBinanceHistoryAndRipple({ sourceId, curve, today: TODAY });

    // The earlier month-end keeps ONLY the fund value — no binance row was frozen
    // there (it sits below `start`), so its gross is unchanged.
    expect(await grossAt(store, "2026-02-28")).toBe(1_000_00);

    // The binance asset's frozen rows — by date and value.
    const binanceRows = (
      await store.snapshots
        // Individual mode freezes rows under the single household scope (#269).
        .readSnapshotHoldings({ holdingId: assetId, scopeId: "household" })
    )
      .filter((row) => row.kind === "asset")
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

    // The binance row exists ONLY at the curve start (the "Datos desde" basis), valued
    // balance × that-day price = 1 × 100 = 100.00 — NOT at the earlier 2026-02-28.
    expect(binanceRows.map((row) => row.dateKey)).toEqual(["2026-04-30"]);
    expect(binanceRows[0]!.valueMinor).toBe(100_00);

    // The whole-portfolio gross at the start carries the still-held fund + binance.
    expect(await grossAt(store, "2026-04-30")).toBe(1_000_00 + 100_00);
    store.close();
  });

  test("ADDS the binance value to a mid-window, NON-month-end existing snapshot (#250)", async () => {
    // Isolates the union branch: an existing snapshot in [start, today) that is NOT a
    // month-end. A mid-month buy generates the 2026-03-15 snapshot; the curve prices
    // 2026-03 on 2026-03-15 (so start = 2026-03-15, a non-month-end day in the window).
    const store = await createInMemoryStore();
    await seed(store);
    await recordBuy(store, "2026-03-15", "10", "100"); // fund cost basis 1000.00 on a mid-month day
    expect(await grossAt(store, "2026-03-15")).toBe(1_000_00);

    const { sourceId } = await connectBinance(store);
    await store.applyBinanceHistoryAndRipple({
      sourceId,
      curve: curveOf({
        monthEndBalances: { "2026-03": "1" },
        dailyPrices: { "2026-03-15": "100" }, // valued only on the mid-month day
      }),
      today: TODAY,
    });

    // The fund row is preserved and the binance value (1 × 100 = 100.00) is ADDED on
    // top of the existing mid-window snapshot.
    expect(await grossAt(store, "2026-03-15")).toBe(1_000_00 + 100_00);
    store.close();
  });

  test("a null curve start is a no-op", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId } = await connectBinance(store);

    // A curve with balances but no prices values nothing → start null.
    await store.applyBinanceHistoryAndRipple({
      sourceId,
      curve: curveOf({
        monthEndBalances: { "2026-03": "1" },
        dailyPrices: {},
      }),
      today: TODAY,
    });

    expect(await dateKeys(store)).toEqual([]);
    store.close();
  });

  test("per-scope in household mode", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
      ],
      mode: "household",
    });
    // Binance owned 70/30 between Jose and Ana.
    const { sourceId } = await store.connectedSources.connect({
      adapter: "binance",
      label: "Binance",
      credentialsJson: JSON.stringify({ apiKey: "KEY", apiSecret: "SECRET" }),
      ownership: [
        { memberId: "mJ", shareBps: 7_000 },
        { memberId: "mA", shareBps: 3_000 },
      ],
    });

    await store.applyBinanceHistoryAndRipple({
      sourceId,
      curve: curveOf({
        monthEndBalances: { "2026-03": "1" },
        dailyPrices: { "2026-03-31": "100" }, // global value 100.00
      }),
      today: TODAY,
    });

    const snaps = await store.snapshots.readSnapshots();
    const household = snaps.find(
      (s) => s.scopeId === "household" && s.dateKey === "2026-03-31",
    )!;
    const jose = snaps.find((s) => s.scopeId === "mJ" && s.dateKey === "2026-03-31")!;
    const ana = snaps.find((s) => s.scopeId === "mA" && s.dateKey === "2026-03-31")!;
    expect(household.grossAssets.amountMinor).toBe(100_00);
    expect(jose.grossAssets.amountMinor).toBe(70_00);
    expect(ana.grossAssets.amountMinor).toBe(30_00);
    store.close();
  });
});
