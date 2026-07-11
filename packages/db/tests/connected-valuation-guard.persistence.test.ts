/**
 * Store-level guard: manual valuation facts rejected on connected holdings (#945).
 */

import { createInMemoryStore, type WorthlineStore } from "@db/index";
import { afterEach, describe, expect, test } from "vitest";

const MEMBER_ID = "member_yo";

let store: WorthlineStore;

async function seed(): Promise<{ assetId: string }> {
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Yo" }],
    mode: "individual",
  });

  const { assetId } = await store.connectedSources.connect({
    adapter: "binance",
    label: "Binance",
    credentialsJson: JSON.stringify({ apiKey: "KEY", apiSecret: "SECRET" }),
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });

  return { assetId };
}

afterEach(() => {
  store?.close();
});

describe("updateAssetValuation — connected holding guard", () => {
  test("rejects a hand-set value on a connected asset", async () => {
    const { assetId } = await seed();

    await expect(store.assets.updateAssetValuation(assetId, 99_999)).rejects.toThrow(
      /connected/i,
    );

    const asset = (await store.assets.readAssets()).find((a) => a.id === assetId)!;
    expect(asset.currentValue.amountMinor).toBe(0);
  });
});

describe("recordOperation — connected holding guard", () => {
  test("rejects an operation on a connected asset", async () => {
    const { assetId } = await seed();

    await expect(
      store.operations.recordOperation({
        assetId,
        currency: "EUR",
        executedAt: "2026-01-01",
        feesMinor: 0,
        id: "op_connected",
        kind: "buy",
        pricePerUnit: "100",
        units: "1",
      }),
    ).rejects.toThrow(/connected/i);
  });
});

describe("updateAsset — ownership remains editable on connected holdings", () => {
  test("allows patching ownership without touching valuation", async () => {
    const { assetId } = await seed();

    await store.assets.updateAsset(assetId, {
      name: "Binance EU",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    });

    const asset = (await store.assets.readAssets()).find((a) => a.id === assetId)!;
    expect(asset.name).toBe("Binance EU");
    expect(asset.ownership).toEqual([{ memberId: MEMBER_ID, shareBps: 10_000 }]);
  });
});
