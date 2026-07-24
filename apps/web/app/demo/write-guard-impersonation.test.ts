/**
 * Write-guard tests for admin impersonation (#697, ADR 0030). Mocks
 * `readStoreTarget` directly with a canned {@link StoreTarget} — the
 * resolution logic that decides WHEN a target is impersonated is already
 * covered by `store-resolver.test.ts` and `read-store-target.test.ts`; this
 * file only asserts what `write-guard.ts` does with an already-impersonated
 * target: block writes, with the Spanish read-only message, store untouched.
 */

import type { StoreTarget } from "@web/store-resolver";

import { createInMemoryStore } from "@worthline/db";
import { describe, expect, it, vi } from "vitest";

let mockTarget: StoreTarget = { kind: "local" };

vi.mock("@web/read-store-target", () => ({
  readStoreTarget: async () => mockTarget,
}));

import {
  guardDemoWrite,
  IMPERSONATION_READONLY_MESSAGE,
  isImpersonating,
  isWriteBlocked,
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

describe("isWriteBlocked (#1180)", () => {
  /**
   * The non-redirecting form of the guard, for an action that must refuse
   * silently instead of navigating (a `void` action fired mid-conversation).
   * `guardDemoWrite` throws Next's redirect signal, which would be wrong there.
   */
  it("is false for a live request — the caller's own workspace, or local dev", async () => {
    mockTarget = OWN_TARGET;
    expect(await isWriteBlocked()).toBe(false);

    mockTarget = { kind: "local" };
    expect(await isWriteBlocked()).toBe(false);
  });

  it("is true for the read-only demo", async () => {
    mockTarget = { kind: "demo", persona: "familia", now: "2026-07-24T00:00:00.000Z" };
    expect(await isWriteBlocked()).toBe(true);
  });

  it("is true for an admin impersonating another workspace", async () => {
    mockTarget = IMPERSONATED_TARGET;
    expect(await isWriteBlocked()).toBe(true);
  });

  it("agrees with guardDemoWrite on every target (one source of truth)", async () => {
    for (const target of [
      OWN_TARGET,
      IMPERSONATED_TARGET,
      { kind: "local" } as StoreTarget,
      {
        kind: "demo",
        persona: "familia",
        now: "2026-07-24T00:00:00.000Z",
      } as StoreTarget,
    ]) {
      mockTarget = target;
      const blocked = await isWriteBlocked();
      let redirected = false;
      try {
        await guardDemoWrite("/patrimonio");
      } catch {
        redirected = true;
      }
      expect(redirected).toBe(blocked);
    }
  });
});
