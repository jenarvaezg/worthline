/**
 * Connected-source cross-cutting seams (issue #487): unit tests for the two store
 * methods extracted into `./connected-source-seams` — `syncConnectedSource` (the
 * coin purchase-date ripple, ADR 0017) and `applyBinanceHistoryAndRipple` (the
 * Binance monthly-history backfill, ADR 0021). Behavioral, through the public
 * store (`createInMemoryStore` → connect → sync → snapshot reads), mirroring the
 * established src-local store-test style. These guard that the factory wiring
 * (substituted store/snapshot/getWorkspace handles) preserves the seam behavior;
 * the deeper edge matrix lives in the `tests/*.persistence.test.ts` integration
 * suites.
 */
import { describe, expect, it } from "vitest";

import type { BinanceHistoryCurve, CoinPosition, DecimalString } from "@worthline/domain";

import { createInMemoryStore } from "./index";
import type { SourcePositionInput, WorthlineStore } from "./index";

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

/** A backdated buy that GENERATES the snapshot at its date (the no-price fund
 *  freezes at cost basis), so the seams have an existing snapshot to land in. */
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

async function connectNumista(
  store: WorthlineStore,
): Promise<{ sourceId: string; assetId: string }> {
  return await store.connectedSources.connect({
    adapter: "numista",
    credentialsJson: JSON.stringify({ apiKey: "secret" }),
    label: "Colección Numista",
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

/** A numismatic-valued coin position (coinValue == the figure passed in). */
function coin(
  externalId: string,
  purchaseDate: string | null,
  valueMinor: number,
): Omit<CoinPosition, "id" | "sourceId"> {
  return {
    kind: "coin",
    catalogueId: `cat-${externalId}`,
    currency: "EUR",
    externalId,
    finenessMillis: null,
    grade: "unc",
    issueId: null,
    liquidityTier: "illiquid",
    metal: "silver",
    metalValueMinor: null,
    name: `Coin ${externalId}`,
    numismaticFetchedAt: null,
    numismaticValueMinor: valueMinor,
    obverseThumbUrl: null,
    purchaseDate,
    purchasePriceMinor: null,
    quantity: 1,
    weightGrams: null,
    year: null,
  };
}

async function syncCoins(
  store: WorthlineStore,
  sourceId: string,
  positions: SourcePositionInput[],
  syncedAt = "2026-06-15T10:00:00.000Z",
): Promise<void> {
  await store.syncConnectedSource({ positions, sourceId, syncedAt });
}

/** A BTC-only curve from per-month balances + per-date prices. */
function curveOf(input: {
  monthEndBalances: Record<string, DecimalString>;
  dailyPrices: Record<string, DecimalString>;
}): BinanceHistoryCurve {
  return {
    monthEndBalances: new Map([
      ["BTC", new Map<string, DecimalString>(Object.entries(input.monthEndBalances))],
    ]),
    dailyPriceBySymbol: new Map([
      ["BTC", new Map<string, DecimalString>(Object.entries(input.dailyPrices))],
    ]),
  };
}

async function grossAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey)
    ?.grossAssets.amountMinor;
}

describe("syncConnectedSource — coin purchase-date ripple (ADR 0017)", () => {
  it("ripples a first-seen dated coin into snapshots on/after its purchase date, not before", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await recordBuy(store, "2024-01-10", "10", "100"); // fund 1000.00 (before the coin)
    await recordBuy(store, "2024-03-01", "5", "200"); // fund cost basis 2000.00 (after)

    const { sourceId } = await connectNumista(store);
    await syncCoins(store, sourceId, [coin("c1", "2024-02-01", 300_00)]);

    // Before the purchase date → untouched; on/after → the coin's frozen value lands.
    expect(await grossAt(store, "2024-01-10")).toBe(10 * 100_00);
    expect(await grossAt(store, "2024-03-01")).toBe(10 * 100_00 + 5 * 200_00 + 300_00);
    store.close();
  });

  it("does not re-ripple a position seen on a prior sync (frozen against later price moves)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await recordBuy(store, "2024-03-01", "10", "100"); // fund 1000.00

    const { sourceId } = await connectNumista(store);
    await syncCoins(store, sourceId, [coin("c1", "2024-01-01", 100_00)]);
    expect(await grossAt(store, "2024-03-01")).toBe(1_000_00 + 100_00);

    // Re-sync the SAME external id with a higher value → not a new dated trade.
    await syncCoins(
      store,
      sourceId,
      [coin("c1", "2024-01-01", 500_00)],
      "2026-06-15T11:00:00.000Z",
    );

    // The past snapshot stays frozen at the first-sync value (never re-rippled).
    expect(await grossAt(store, "2024-03-01")).toBe(1_000_00 + 100_00);
    store.close();
  });

  it("does not ripple a coin with no purchase date", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await recordBuy(store, "2024-03-01", "10", "100"); // fund 1000.00

    const { sourceId, assetId } = await connectNumista(store);
    await syncCoins(store, sourceId, [coin("nd", null, 100_00)]);

    // It counts in the live holding but has no dated fact → no past snapshot moves.
    expect(
      (await store.assets.readAssets()).find((a) => a.id === assetId)!.currentValue
        .amountMinor,
    ).toBe(100_00);
    expect(await grossAt(store, "2024-03-01")).toBe(1_000_00);
    store.close();
  });
});

describe("applyBinanceHistoryAndRipple — monthly-history backfill (ADR 0021)", () => {
  it("sets the binance value at completed month-ends and into existing snapshots in the window", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    // A pre-existing snapshot on a month-end date (the backfill sets into it).
    await recordBuy(store, "2026-03-31", "10", "100"); // fund cost basis 1000.00
    expect(await grossAt(store, "2026-03-31")).toBe(1_000_00);

    const { sourceId } = await connectBinance(store);
    await store.applyBinanceHistoryAndRipple({
      sourceId,
      curve: curveOf({
        monthEndBalances: { "2026-03": "1", "2026-04": "1" },
        dailyPrices: { "2026-03-31": "100", "2026-04-30": "100" },
      }),
      today: TODAY,
    });

    // Existing snapshot: fund preserved, binance row (1 × 100 = 100.00) set on top.
    expect(await grossAt(store, "2026-03-31")).toBe(1_000_00 + 100_00);
    // No snapshot at 2026-04-30 → generated as the whole-portfolio reconstruction
    // (the fund's cost basis was already 1000.00 by then) with the binance value
    // overridden on top: 1000.00 + 100.00.
    expect(await grossAt(store, "2026-04-30")).toBe(1_000_00 + 100_00);
    store.close();
  });

  it("is append-only: a date already carrying the binance row is left frozen on re-sync", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId } = await connectBinance(store);

    await store.applyBinanceHistoryAndRipple({
      sourceId,
      curve: curveOf({
        monthEndBalances: { "2026-03": "1" },
        dailyPrices: { "2026-03-31": "100" },
      }),
      today: TODAY,
    });
    expect(await grossAt(store, "2026-03-31")).toBe(100_00);

    // Re-sync the same month at a HIGHER price → the covered date is skipped.
    await store.applyBinanceHistoryAndRipple({
      sourceId,
      curve: curveOf({
        monthEndBalances: { "2026-03": "1" },
        dailyPrices: { "2026-03-31": "999" },
      }),
      today: TODAY,
    });

    // The 2026-03-31 row stays frozen at the original 100.00 (never rewritten).
    expect(await grossAt(store, "2026-03-31")).toBe(100_00);
    store.close();
  });
});
