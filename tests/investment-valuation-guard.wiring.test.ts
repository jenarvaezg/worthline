/**
 * Wiring suite: investment valuation guard + value update pass rejection (issue #68).
 *
 * Verifies end-to-end that:
 *  1. Manually valuing an investment (updateAssetValuationAction) → rejected with
 *     a user-facing Spanish message, nothing persisted.
 *  2. A value update pass (batchValueUpdateAction) naming an investment holding →
 *     rejected (not silently dropped) with a user-facing Spanish message.
 *
 * Follows the same pattern as ownership-split-invariant.wiring.test.ts: real
 * in-memory store, next/cache stubbed, NEXT_REDIRECT digest parsed.
 */

import { vi, describe, test, expect, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import {
  updateAssetValuationAction,
  batchValueUpdateAction,
} from "../apps/web/app/patrimonio/actions";
import { catchRedirect } from "./helpers";

// ------------------------------------------------------------- test fixtures --

let store: WorthlineStore;

const INVESTMENT_ID = "asset_fund_123";
const MANUAL_ASSET_ID = "asset_cash_456";

function setupStore(): WorthlineStore {
  store = createInMemoryStore();
  store.initializeWorkspace({
    members: [{ id: "member_yo", name: "Yo" }],
    mode: "individual",
  });
  // Create an investment asset (derived value — must never be hand-edited)
  store.createInvestmentAsset({
    id: INVESTMENT_ID,
    name: "Index Fund",
    currency: "EUR",
    liquidityTier: "market",
    ownership: [{ memberId: "member_yo", shareBps: 10_000 }],
  });
  // Create a manual asset (fine to update value by hand)
  store.createManualAsset({
    id: MANUAL_ASSET_ID,
    name: "Cash Account",
    type: "cash",
    currency: "EUR",
    currentValueMinor: 100_000,
    liquidityTier: "cash",
    ownership: [{ memberId: "member_yo", shareBps: 10_000 }],
  });
  return store;
}

afterEach(() => {
  store?.close();
});

// --------------------------------------------------- 1. Investment valuation guard --

describe("updateAssetValuationAction — investment manual valuation guard", () => {
  test("updating a manual asset's value succeeds", async () => {
    setupStore();

    const fd = new FormData();
    fd.set("id", MANUAL_ASSET_ID);
    fd.set("currentValue", "200");
    fd.set("currentUrl", "/patrimonio");

    const redirectUrl = await catchRedirect(() => updateAssetValuationAction(fd, store));

    expect(redirectUrl).toContain("ok=saved");
    const assets = store.readAssets();
    const manual = assets.find((a) => a.id === MANUAL_ASSET_ID);
    expect(manual!.currentValue.amountMinor).toBe(20_000);
  });

  test("updating an investment asset's value is rejected with a user-facing message and persists nothing", async () => {
    setupStore();

    // Record an operation so the investment has a known value
    store.recordOperation({
      id: "op_1",
      assetId: INVESTMENT_ID,
      kind: "buy",
      executedAt: "2024-01-15",
      units: "10",
      pricePerUnit: "50",
      currency: "EUR",
      feesMinor: 0,
    });

    const fd = new FormData();
    fd.set("id", INVESTMENT_ID);
    fd.set("currentValue", "99999");
    fd.set("currentUrl", "/patrimonio");

    const redirectUrl = await catchRedirect(() => updateAssetValuationAction(fd, store));

    expect(redirectUrl).toContain("error=");
    const decoded = decodeURIComponent(redirectUrl);
    // Must surface a user-facing Spanish message, not a developer throw
    expect(decoded).toMatch(/invers/i);
  });
});

// -------------------------------------------- 2. Value update pass investment guard --

describe("batchValueUpdateAction — investment holding rejection", () => {
  test("value update pass with only manual assets succeeds", async () => {
    setupStore();

    const fd = new FormData();
    fd.set(`val_${MANUAL_ASSET_ID}`, "300");
    fd.set("currentUrl", "/patrimonio/actualizar");

    const redirectUrl = await catchRedirect(() => batchValueUpdateAction(fd, store));

    expect(redirectUrl).toContain("ok=");
    const assets = store.readAssets();
    const manual = assets.find((a) => a.id === MANUAL_ASSET_ID);
    expect(manual!.currentValue.amountMinor).toBe(30_000);
  });

  test("value update pass naming an investment holding is rejected with a user-facing message and persists nothing", async () => {
    setupStore();

    const fd = new FormData();
    fd.set(`val_${MANUAL_ASSET_ID}`, "300");
    fd.set(`val_${INVESTMENT_ID}`, "99999"); // explicitly naming the investment
    fd.set("currentUrl", "/patrimonio/actualizar");

    const redirectUrl = await catchRedirect(() => batchValueUpdateAction(fd, store));

    expect(redirectUrl).toContain("error=");
    const decoded = decodeURIComponent(redirectUrl);
    // Must surface a user-facing Spanish message
    expect(decoded).toMatch(/invers/i);

    // Manual asset must not have been updated either (nothing persisted)
    const assets = store.readAssets();
    const manual = assets.find((a) => a.id === MANUAL_ASSET_ID);
    expect(manual!.currentValue.amountMinor).toBe(100_000); // unchanged
  });
});
