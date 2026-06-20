/**
 * Demo write guard tests (S2 #300). Asserts the guard's observable contract: a
 * no-op when live, a "deshabilitado" redirect in demo mode, and — through a
 * representative mutating action — that the store is left untouched.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createInMemoryStore } from "@worthline/db";

import { DEMO_DISABLED_MESSAGE, guardDemoWrite, isDemoMode } from "@web/demo/write-guard";
import { deleteAssetAction } from "@web/patrimonio/actions";

afterEach(() => {
  delete process.env.DEMO;
});

/** Run an action expecting it to throw redirect(); return the redirect digest. */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

describe("demo write guard", () => {
  it("is a no-op when DEMO is unset", () => {
    expect(isDemoMode()).toBe(false);
    expect(() => guardDemoWrite("/patrimonio")).not.toThrow();
  });

  it("redirects with the deshabilitado message in demo mode", async () => {
    process.env.DEMO = "1";
    expect(isDemoMode()).toBe(true);

    const digest = await redirectOf(async () => guardDemoWrite("/patrimonio"));
    const decoded = decodeURIComponent(digest.replace(/\+/g, " "));
    expect(decoded).toContain(DEMO_DISABLED_MESSAGE);
  });

  it("blocks a representative mutating action and leaves the store untouched", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "m1", name: "Uno" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "asset_keep",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
      type: "cash",
    });

    process.env.DEMO = "1";
    const fd = new FormData();
    fd.set("id", "asset_keep");
    fd.set("currentUrl", "/patrimonio");

    const digest = await redirectOf(async () => deleteAssetAction(fd, store));
    expect(decodeURIComponent(digest.replace(/\+/g, " "))).toContain(
      DEMO_DISABLED_MESSAGE,
    );

    // The asset is still there — the guard short-circuited before the store.
    const assets = await store.assets.readAssets();
    expect(assets.some((a) => a.id === "asset_keep")).toBe(true);

    store.close();
  });
});
