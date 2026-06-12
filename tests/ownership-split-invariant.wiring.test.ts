/**
 * Wiring suite: ownership-split invariant reporting (issue #66).
 *
 * Verifies end-to-end that:
 *  - valid split (totals 100%) → asset / liability persisted, success redirect
 *  - invalid split (≠ 100%) → domain constructor returns violation data with
 *    a stable code, and the action surfaces the exact existing Spanish message
 *    while persisting nothing
 *
 * Two layers:
 *  1. Domain constructor unit tests — `createManualAssetSafe` / `createLiabilitySafe`
 *     report violations as data (not throw).
 *  2. Action wiring tests — `createAssetAction` / `createLiabilityAction` map the
 *     violation code to the exact Spanish message (FormData in, redirect-or-error out).
 *
 * Follows the same pattern as create-asset-action.wiring.test.ts: real in-memory
 * store, next/cache stubbed, NEXT_REDIRECT digest parsed.
 */

import { vi, describe, test, expect, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import {
  createAssetAction,
  createLiabilityAction,
} from "../apps/web/app/patrimonio/actions";
import {
  createManualAssetSafe,
  createLiabilitySafe,
  createWorkspace,
} from "@worthline/domain";
import { catchRedirect, errorMessageOf } from "./helpers";

function buildAssetFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("name", "Test Asset");
  fd.set("type", "cash");
  fd.set("currentValue", "1000");
  fd.set("liquidityTier", "cash");
  fd.set("ownershipPreset", "custom");
  fd.set("currentUrl", "/patrimonio");

  for (const [key, value] of Object.entries(overrides)) {
    fd.set(key, value);
  }

  return fd;
}

function buildLiabilityFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("name", "Test Debt");
  fd.set("type", "debt");
  fd.set("balance", "5000");
  fd.set("ownershipPreset", "custom");
  fd.set("currentUrl", "/patrimonio");

  for (const [key, value] of Object.entries(overrides)) {
    fd.set(key, value);
  }

  return fd;
}

// ------------------------------------------------------------- test fixtures --

let store: WorthlineStore;

afterEach(() => {
  store?.close();
});

// ------------------------------------------------ 1. Domain constructor unit tests --

describe("createManualAssetSafe — ownership-split invariant", () => {
  const workspace = createWorkspace({
    mode: "household",
    members: [
      { id: "member_ana", name: "Ana" },
      { id: "member_jose", name: "Jose" },
    ],
  });

  const baseInput = {
    id: "asset_test",
    name: "Test Asset",
    type: "cash" as const,
    currency: "EUR" as const,
    currentValueMinor: 100_000,
    liquidityTier: "cash" as const,
    isPrimaryResidence: false,
  };

  test("valid split (totals 10000 bps) returns ok: true with the asset", () => {
    const result = createManualAssetSafe(workspace, {
      ...baseInput,
      ownership: [
        { memberId: "member_ana", shareBps: 6_000 },
        { memberId: "member_jose", shareBps: 4_000 },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("Test Asset");
      expect(result.value.ownership).toHaveLength(2);
    }
  });

  test("split totaling 12000 bps (120%) returns ok: false with ownership_split_invalid code", () => {
    const result = createManualAssetSafe(workspace, {
      ...baseInput,
      ownership: [
        { memberId: "member_ana", shareBps: 6_000 },
        { memberId: "member_jose", shareBps: 6_000 },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.code).toBe("ownership_split_invalid");
      expect(result.violations[0]!.totalBps).toBe(12_000);
    }
  });

  test("split totaling 7000 bps (70%) returns ok: false with ownership_split_invalid code", () => {
    const result = createManualAssetSafe(workspace, {
      ...baseInput,
      ownership: [
        { memberId: "member_ana", shareBps: 3_000 },
        { memberId: "member_jose", shareBps: 4_000 },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]!.code).toBe("ownership_split_invalid");
      expect(result.violations[0]!.totalBps).toBe(7_000);
    }
  });
});

describe("createLiabilitySafe — ownership-split invariant", () => {
  const workspace = createWorkspace({
    mode: "household",
    members: [
      { id: "member_ana", name: "Ana" },
      { id: "member_jose", name: "Jose" },
    ],
  });

  const baseInput = {
    id: "liability_test",
    name: "Test Debt",
    type: "debt" as const,
    currency: "EUR" as const,
    balanceMinor: 200_000,
  };

  test("valid split (totals 10000 bps) returns ok: true with the liability", () => {
    const result = createLiabilitySafe(workspace, {
      ...baseInput,
      ownership: [
        { memberId: "member_ana", shareBps: 5_000 },
        { memberId: "member_jose", shareBps: 5_000 },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("Test Debt");
    }
  });

  test("split totaling 7000 bps (70%) returns ok: false with ownership_split_invalid code", () => {
    const result = createLiabilitySafe(workspace, {
      ...baseInput,
      ownership: [
        { memberId: "member_ana", shareBps: 3_000 },
        { memberId: "member_jose", shareBps: 4_000 },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]!.code).toBe("ownership_split_invalid");
      expect(result.violations[0]!.totalBps).toBe(7_000);
    }
  });
});

// ---------------------------------------- 2. Action wiring tests (end-to-end) --

describe("createAssetAction — ownership-split wiring", () => {
  test("valid split (100%) persists the holding and redirects to success", async () => {
    store = createInMemoryStore();
    store.initializeWorkspace({
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
      ],
      mode: "household",
    });

    const fd = buildAssetFormData({
      name: "Cuenta corriente",
      ownershipPreset: "custom",
      owner_member_ana: "60",
      owner_member_jose: "40",
    });

    const redirectUrl = await catchRedirect(() => createAssetAction(fd, store));

    expect(redirectUrl).toContain("ok=asset_added");
    expect(store.readAssets()).toHaveLength(1);
  });

  test("custom split totaling 120% surfaces the exact Spanish message and persists nothing", async () => {
    store = createInMemoryStore();
    store.initializeWorkspace({
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
      ],
      mode: "household",
    });

    const fd = buildAssetFormData({
      name: "Activo",
      ownershipPreset: "custom",
      owner_member_ana: "60",
      owner_member_jose: "60",
    });

    const redirectUrl = await catchRedirect(() => createAssetAction(fd, store));

    expect(redirectUrl).toContain("error=");
    expect(errorMessageOf(redirectUrl)).toBe("La propiedad suma 120% — debe sumar 100%.");
    expect(store.readAssets()).toHaveLength(0);
  });
});

describe("createLiabilityAction — ownership-split wiring", () => {
  test("valid split (100%) persists the liability and redirects to success", async () => {
    store = createInMemoryStore();
    store.initializeWorkspace({
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
      ],
      mode: "household",
    });

    const fd = buildLiabilityFormData({
      name: "Hipoteca",
      balance: "200000",
      ownershipPreset: "custom",
      owner_member_ana: "50",
      owner_member_jose: "50",
    });

    const redirectUrl = await catchRedirect(() => createLiabilityAction(fd, store));

    expect(redirectUrl).toContain("ok=liability_added");
    expect(store.readLiabilities()).toHaveLength(1);
  });
});
