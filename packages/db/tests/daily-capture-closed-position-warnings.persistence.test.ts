/**
 * The daily capture must not freeze avisos the app no longer shows (#1364).
 *
 * `collectWarnings` stopped asking a fully-sold holding for a provider symbol in
 * #1348, but the capture path called it with no net-units map and no overrides —
 * so `warnings_json` kept recording a pending task the live salud-de-datos panel
 * already considers gone, and an override the user already acknowledged. The two
 * surfaces disagreed about the same fact and the one written to disk was wrong.
 */

import type { WorthlineStore } from "@db/index";

import { captureDailySnapshotForWorkspace, createInMemoryStore } from "@db/index";
import { describe, expect, test } from "vitest";

const TODAY = "2026-08-05";
const NOW = `${TODAY}T21:00:00.000Z`;

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  // Cash keeps the portfolio (and therefore every capture) non-empty.
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 10_000_00,
    id: "cash",
    liquidityTier: "cash",
    name: "Cuenta",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "cash",
  });
  // No providerSymbol: the MISSING_PROVIDER_SYMBOL candidate (ADR 0055).
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    liquidityTier: "market",
    name: "Fondo sin símbolo",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
}

async function buy(store: WorthlineStore, units: string): Promise<void> {
  await store.command.recordInvestmentOperation(
    {
      assetId: "fund",
      currency: "EUR",
      executedAt: "2026-01-10",
      feesMinor: 0,
      id: "op_buy",
      kind: "buy",
      pricePerUnit: "100",
      units,
    },
    { today: TODAY },
  );
}

async function sell(store: WorthlineStore, units: string): Promise<void> {
  await store.command.recordInvestmentOperation(
    {
      assetId: "fund",
      currency: "EUR",
      executedAt: "2026-03-20",
      feesMinor: 0,
      id: "op_sell",
      kind: "sell",
      pricePerUnit: "110",
      units,
    },
    { today: TODAY },
  );
}

/** The codes frozen into today's persisted capture for the household scope. */
async function capturedCodes(store: WorthlineStore): Promise<string[]> {
  const snapshots = await store.snapshots.readSnapshots("household");
  const today = snapshots.find((snapshot) => snapshot.dateKey === TODAY);
  expect(today).toBeDefined();
  return today!.warnings.map((warning) => warning.code);
}

describe("daily capture — warnings_json agrees with the live engine (#1364)", () => {
  test("a fully-sold holding no longer freezes MISSING_PROVIDER_SYMBOL", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await buy(store, "10");
    await sell(store, "10");

    await captureDailySnapshotForWorkspace(store, NOW);

    expect(await capturedCodes(store)).toEqual([]);
    store.close();
  });

  test("an open holding without a symbol still freezes it — the task is real", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await buy(store, "10");

    await captureDailySnapshotForWorkspace(store, NOW);

    expect(await capturedCodes(store)).toEqual(["MISSING_PROVIDER_SYMBOL"]);
    store.close();
  });

  test("an acknowledged warning is not frozen into the capture", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await buy(store, "10");
    await store.acknowledgeWarning("MISSING_PROVIDER_SYMBOL", "fund");

    await captureDailySnapshotForWorkspace(store, NOW);

    expect(await capturedCodes(store)).toEqual([]);
    store.close();
  });
});
