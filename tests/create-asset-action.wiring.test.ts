/**
 * Wiring suite: manual-asset creation action (createAssetAction).
 *
 * Tests the server action through its real public interface — FormData in,
 * redirect-or-error out — with assertions on store state.  No mocking of the
 * store; the in-memory adapter runs the real schema and migration ladder.
 *
 * next/cache (revalidatePath) is stubbed at the module level because it has no
 * meaningful behaviour in a node test environment (it is a no-op signal to the
 * Next.js router).  next/navigation (redirect) is NOT mocked: the action throws
 * the NEXT_REDIRECT sentinel that Next itself throws — we catch it and extract
 * the destination URL.
 */

import { vi, describe, test, expect, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { createAssetAction } from "../apps/web/app/patrimonio/actions";
import { catchRedirect } from "./helpers";

/** Build a minimal FormData for the create-asset form. */
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

// ------------------------------------------------------------- test fixtures --

let store: WorthlineStore;

afterEach(() => {
  store?.close();
});

// -------------------------------------------------------------------- tests --

describe("createAssetAction wiring", () => {
  test("happy path: persists holding with ownership split and redirects to success URL", async () => {
    store = createInMemoryStore();
    store.workspace.initializeWorkspace({
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
      ],
      mode: "household",
    });

    const fd = buildAssetFormData({
      name: "Cuenta corriente",
      type: "cash",
      currentValue: "5000",
      liquidityTier: "cash",
      // custom ownership split: Ana 25%, Jose 75%
      ownershipPreset: "custom",
      [`owner_member_ana`]: "25",
      [`owner_member_jose`]: "75",
    });

    const redirectUrl = await catchRedirect(() => createAssetAction(fd, store));

    // Redirect should signal success
    expect(redirectUrl).toContain("ok=asset_added");

    // Store state: one holding persisted with the correct ownership split
    const assets = store.assets.readAssets();
    expect(assets).toHaveLength(1);

    const [asset] = assets;
    expect(asset!.name).toBe("Cuenta corriente");
    expect(asset!.currentValue.amountMinor).toBe(500_000); // 5000 EUR in minor units (cents)
    expect(asset!.liquidityTier).toBe("cash");

    // Ownership split matches what was submitted
    const ownership = asset!.ownership;
    expect(ownership).toHaveLength(2);

    const anaShare = ownership.find((s) => s.memberId === "member_ana");
    const joseShare = ownership.find((s) => s.memberId === "member_jose");
    expect(anaShare?.shareBps).toBe(2_500); // 25%
    expect(joseShare?.shareBps).toBe(7_500); // 75%
  });

  test("invalid submission: blank name produces error redirect, store unchanged", async () => {
    store = createInMemoryStore();
    store.workspace.initializeWorkspace({
      members: [{ id: "member_yo", name: "Yo" }],
      mode: "individual",
    });

    const fd = buildAssetFormData({ name: "" }); // blank name — should fail validation

    const redirectUrl = await catchRedirect(() => createAssetAction(fd, store));

    // Redirect should signal an error
    expect(redirectUrl).toContain("error=");
    expect(decodeURIComponent(redirectUrl)).toContain("obligatorio");

    // Store state: nothing persisted
    expect(store.assets.readAssets()).toHaveLength(0);
  });
});
