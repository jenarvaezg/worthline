/**
 * Wiring suite: connected-source manual valuation guard (#945).
 *
 * Verifies end-to-end that hand-editing a connected holding's value is rejected
 * with a user-facing Spanish message and nothing is persisted.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { updateAssetValuationAction } from "@web/patrimonio/actions";
import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { catchRedirect } from "./helpers";

const MEMBER_ID = "member_yo";

let store: WorthlineStore;
let connectedAssetId: string;
const MANUAL_ASSET_ID = "asset_cash_456";

async function setupStore(): Promise<void> {
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Yo" }],
    mode: "individual",
  });

  const connected = await store.connectedSources.connect({
    adapter: "binance",
    label: "Binance",
    credentialsJson: JSON.stringify({ apiKey: "KEY", apiSecret: "SECRET" }),
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
  connectedAssetId = connected.assetId;

  await store.assets.createManualAsset({
    id: MANUAL_ASSET_ID,
    name: "Cash Account",
    type: "cash",
    currency: "EUR",
    currentValueMinor: 100_000,
    liquidityTier: "cash",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
}

afterEach(() => {
  store?.close();
});

describe("updateAssetValuationAction — connected manual valuation guard", () => {
  test("updating a manual asset's value still succeeds", async () => {
    await setupStore();

    const fd = new FormData();
    fd.set("id", MANUAL_ASSET_ID);
    fd.set("currentValue", "200");
    fd.set("currentUrl", "/patrimonio");

    const redirectUrl = await catchRedirect(() => updateAssetValuationAction(fd, store));

    expect(redirectUrl).toContain("ok=saved");
    const assets = await store.assets.readAssets();
    const manual = assets.find((a) => a.id === MANUAL_ASSET_ID);
    expect(manual!.currentValue.amountMinor).toBe(20_000);
  });

  test("updating a connected asset's value is rejected with a user-facing message and persists nothing", async () => {
    await setupStore();

    const fd = new FormData();
    fd.set("id", connectedAssetId);
    fd.set("currentValue", "99999");
    fd.set("currentUrl", "/patrimonio");

    const redirectUrl = await catchRedirect(() => updateAssetValuationAction(fd, store));

    expect(redirectUrl).toContain("error=");
    const decoded = decodeURIComponent(redirectUrl);
    expect(decoded).toMatch(/conectad|sincroniz/i);

    const assets = await store.assets.readAssets();
    const connected = assets.find((a) => a.id === connectedAssetId);
    expect(connected!.currentValue.amountMinor).toBe(0);
  });
});
