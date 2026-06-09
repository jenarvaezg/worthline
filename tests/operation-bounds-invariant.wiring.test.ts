/**
 * Wiring suite: operation bounds invariants (issue #68).
 *
 * Verifies end-to-end that:
 *  - units ≤ 0 → domain safe constructor returns violation code
 *    `operation_units_not_positive`; action surfaces the existing Spanish message
 *    and persists nothing.
 *  - price < 0 → domain safe constructor returns violation code
 *    `operation_price_negative`; action surfaces the existing Spanish message
 *    and persists nothing.
 *  - fees < 0 → domain safe constructor returns violation code
 *    `operation_fees_negative`; action surfaces the existing Spanish message
 *    and persists nothing.
 *  - valid inputs → operation persisted, success redirect.
 *
 * Follows the same pattern as ownership-split-invariant.wiring.test.ts: real
 * in-memory store, next/cache stubbed, NEXT_REDIRECT digest parsed.
 */

import { vi, describe, test, expect, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { recordOperationAction } from "../apps/web/app/inversiones/actions";
import { createInvestmentOperationSafe } from "@worthline/domain";

// ------------------------------------------------------------------ helpers --

function catchRedirect(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => {
      throw new Error("Expected redirect but action returned normally");
    },
    (err: unknown) => {
      if (
        err instanceof Error &&
        (err.message === "NEXT_REDIRECT" || "digest" in err)
      ) {
        const digest = (err as { digest?: string }).digest ?? "";
        const parts = digest.split(";");
        return parts[2] ?? digest;
      }
      throw err;
    },
  );
}

function buildOperationFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("kind", "buy");
  fd.set("units", "10");
  fd.set("pricePerUnit", "100");
  fd.set("fees", "0");
  fd.set("executedAt", "2024-01-15");
  fd.set("currentUrl", "/inversiones/asset_test_123");

  for (const [key, value] of Object.entries(overrides)) {
    fd.set(key, value);
  }

  return fd;
}

// ------------------------------------------------------------- test fixtures --

let store: WorthlineStore;
const ASSET_ID = "asset_test_123";

function setupStoreWithInvestment(): WorthlineStore {
  store = createInMemoryStore();
  store.initializeWorkspace({
    members: [{ id: "member_yo", name: "Yo" }],
    mode: "individual",
  });
  store.createInvestmentAsset({
    id: ASSET_ID,
    name: "Test Fund",
    currency: "EUR",
    liquidityTier: "market",
    ownership: [{ memberId: "member_yo", shareBps: 10_000 }],
  });
  return store;
}

afterEach(() => {
  store?.close();
});

// -------------------------------------------- 1. Domain constructor unit tests --

describe("createInvestmentOperationSafe — operation bounds invariants", () => {
  const baseInput = {
    id: "op_test",
    assetId: "asset_test",
    kind: "buy" as const,
    executedAt: "2024-01-15",
    pricePerUnit: "100" as const,
    currency: "EUR" as const,
  };

  test("valid operation returns ok: true with the operation", () => {
    const result = createInvestmentOperationSafe({
      ...baseInput,
      units: "10",
      feesMinor: 500,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.units).toBe("10");
      expect(result.value.feesMinor).toBe(500);
    }
  });

  test("zero units returns ok: false with operation_units_not_positive code", () => {
    const result = createInvestmentOperationSafe({ ...baseInput, units: "0" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]!.code).toBe("operation_units_not_positive");
    }
  });

  test("negative units returns ok: false with operation_units_not_positive code", () => {
    const result = createInvestmentOperationSafe({ ...baseInput, units: "-5" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]!.code).toBe("operation_units_not_positive");
    }
  });

  test("negative price returns ok: false with operation_price_negative code", () => {
    const result = createInvestmentOperationSafe({
      ...baseInput,
      units: "10",
      pricePerUnit: "-1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]!.code).toBe("operation_price_negative");
    }
  });

  test("negative fees returns ok: false with operation_fees_negative code", () => {
    const result = createInvestmentOperationSafe({
      ...baseInput,
      units: "10",
      feesMinor: -100,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]!.code).toBe("operation_fees_negative");
    }
  });
});

// ------------------------------------------- 2. Action wiring tests (end-to-end) --

describe("recordOperationAction — operation bounds wiring", () => {
  test("valid operation persists and redirects to success", async () => {
    setupStoreWithInvestment();

    const fd = buildOperationFormData({
      units: "5",
      pricePerUnit: "200",
      fees: "10",
    });

    const redirectUrl = await catchRedirect(() =>
      recordOperationAction(ASSET_ID, fd, store),
    );

    expect(redirectUrl).toContain("ok=saved");
    expect(store.readOperations(ASSET_ID)).toHaveLength(1);
  });

  test("zero units → error redirect, nothing persisted", async () => {
    setupStoreWithInvestment();

    const fd = buildOperationFormData({ units: "0" });

    const redirectUrl = await catchRedirect(() =>
      recordOperationAction(ASSET_ID, fd, store),
    );

    expect(redirectUrl).toContain("error=");
    const decoded = decodeURIComponent(redirectUrl);
    expect(decoded).toContain("positiv");
    expect(store.readOperations(ASSET_ID)).toHaveLength(0);
  });

  test("negative price → error redirect, nothing persisted", async () => {
    setupStoreWithInvestment();

    const fd = buildOperationFormData({ pricePerUnit: "-1" });

    const redirectUrl = await catchRedirect(() =>
      recordOperationAction(ASSET_ID, fd, store),
    );

    expect(redirectUrl).toContain("error=");
    expect(store.readOperations(ASSET_ID)).toHaveLength(0);
  });

  test("negative fees → error redirect, nothing persisted", async () => {
    setupStoreWithInvestment();

    const fd = buildOperationFormData({ fees: "-5" });

    const redirectUrl = await catchRedirect(() =>
      recordOperationAction(ASSET_ID, fd, store),
    );

    expect(redirectUrl).toContain("error=");
    expect(store.readOperations(ASSET_ID)).toHaveLength(0);
  });
});
