/**
 * Write-guard tests for admin impersonation (#697, ADR 0030). Mocks
 * `readStoreTarget` directly with a canned {@link StoreTarget} — the
 * resolution logic that decides WHEN a target is impersonated is already
 * covered by `store-resolver.test.ts` and `read-store-target.test.ts`; this
 * file only asserts what `write-guard.ts` does with an already-impersonated
 * target: block writes, with the Spanish read-only message, store untouched.
 */
import { describe, expect, it, vi } from "vitest";

import { createInMemoryStore } from "@worthline/db";

import type { StoreTarget } from "@web/store-resolver";

let mockTarget: StoreTarget = { kind: "local" };

vi.mock("@web/read-store-target", () => ({
  readStoreTarget: async () => mockTarget,
}));

import {
  IMPERSONATION_READONLY_MESSAGE,
  guardDemoWrite,
  isImpersonating,
} from "@web/demo/write-guard";
import { deleteAssetAction } from "@web/patrimonio/actions";

const OWN_TARGET: StoreTarget = {
  kind: "authenticated",
  workspaceId: "ws-ana",
  dbUrl: "libsql://wl-ana.turso.io",
  token: "token",
};

const IMPERSONATED_TARGET: StoreTarget = {
  kind: "authenticated",
  workspaceId: "ws-target",
  dbUrl: "libsql://wl-target.turso.io",
  token: "token",
  impersonatedEmail: "target@example.com",
};

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

describe("isImpersonating", () => {
  it("is false for an ordinary authenticated target", async () => {
    mockTarget = OWN_TARGET;
    expect(await isImpersonating()).toBe(false);
  });

  it("is true when the target carries an impersonatedEmail", async () => {
    mockTarget = IMPERSONATED_TARGET;
    expect(await isImpersonating()).toBe(true);
  });
});

describe("guardDemoWrite while impersonating", () => {
  it("is a no-op for an ordinary authenticated (non-impersonated) target", async () => {
    mockTarget = OWN_TARGET;
    await expect(guardDemoWrite("/patrimonio")).resolves.toBeUndefined();
  });

  it("redirects with the impersonation read-only message", async () => {
    mockTarget = IMPERSONATED_TARGET;

    const digest = await redirectOf(() => guardDemoWrite("/patrimonio"));
    const decoded = decodeURIComponent(digest.replace(/\+/g, " "));
    expect(decoded).toContain(IMPERSONATION_READONLY_MESSAGE);
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

    mockTarget = IMPERSONATED_TARGET;
    const fd = new FormData();
    fd.set("id", "asset_keep");
    fd.set("currentUrl", "/patrimonio");

    const digest = await redirectOf(async () => deleteAssetAction(fd, store));
    expect(decodeURIComponent(digest.replace(/\+/g, " "))).toContain(
      IMPERSONATION_READONLY_MESSAGE,
    );

    // The asset is still there — the guard short-circuited before the store.
    const assets = await store.assets.readAssets();
    expect(assets.some((a) => a.id === "asset_keep")).toBe(true);

    store.close();
  });
});
