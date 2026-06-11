/**
 * Wiring suite: operation bounds invariants (issue #68).
 *
 * Verifies both rejection layers:
 *  - parser-level form errors (empty/zero units, invalid fees) redirect with the
 *    existing Spanish messages and persist nothing.
 *  - domain-constructor errors that survive parsing (negative units, negative
 *    price) return stable violation codes, are mapped to the existing Spanish
 *    messages, and persist nothing.
 *  - valid inputs persist and redirect to success.
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

function errorMessageOf(url: string): string {
  return new URL(url, "http://worthline.local").searchParams.get("error") ?? "";
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

  test("parser rejection: zero units redirects with the positive-units message and persists nothing", async () => {
    setupStoreWithInvestment();

    const fd = buildOperationFormData({ units: "0" });

    const redirectUrl = await catchRedirect(() =>
      recordOperationAction(ASSET_ID, fd, store),
    );

    expect(redirectUrl).toContain("error=");
    expect(errorMessageOf(redirectUrl)).toBe(
      "Las unidades deben ser un número positivo.",
    );
    expect(store.readOperations(ASSET_ID)).toHaveLength(0);
  });

  test("domain rejection: negative units redirects with the positive-units message and persists nothing", async () => {
    setupStoreWithInvestment();

    const fd = buildOperationFormData({ units: "-5" });

    const redirectUrl = await catchRedirect(() =>
      recordOperationAction(ASSET_ID, fd, store),
    );

    expect(redirectUrl).toContain("error=");
    expect(errorMessageOf(redirectUrl)).toBe(
      "Las unidades deben ser un número positivo.",
    );
    expect(store.readOperations(ASSET_ID)).toHaveLength(0);
  });

  test("domain rejection: negative price redirects with the invalid-price message and persists nothing", async () => {
    setupStoreWithInvestment();

    const fd = buildOperationFormData({ pricePerUnit: "-1" });

    const redirectUrl = await catchRedirect(() =>
      recordOperationAction(ASSET_ID, fd, store),
    );

    expect(redirectUrl).toContain("error=");
    expect(errorMessageOf(redirectUrl)).toBe("El precio por unidad no es válido.");
    expect(store.readOperations(ASSET_ID)).toHaveLength(0);
  });

  test("parser rejection: negative fees redirects with the invalid-fees message and persists nothing", async () => {
    setupStoreWithInvestment();

    const fd = buildOperationFormData({ fees: "-5" });

    const redirectUrl = await catchRedirect(() =>
      recordOperationAction(ASSET_ID, fd, store),
    );

    expect(redirectUrl).toContain("error=");
    expect(errorMessageOf(redirectUrl)).toBe("Las comisiones no son válidas.");
    expect(store.readOperations(ASSET_ID)).toHaveLength(0);
  });
});
