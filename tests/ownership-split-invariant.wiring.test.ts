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

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { type WorthlineStore } from "@worthline/db";
import {
  createLiabilitySafe,
  createManualAssetSafe,
  createWorkspace,
} from "@worthline/domain";

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

  test("real estate can be owned partially by known household members", () => {
    const result = createManualAssetSafe(workspace, {
      ...baseInput,
      liquidityTier: "housing",
      type: "real_estate",
      ownership: [{ memberId: "member_ana", shareBps: 5_000 }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ownership).toEqual([
        { memberId: "member_ana", shareBps: 5_000 },
      ]);
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
