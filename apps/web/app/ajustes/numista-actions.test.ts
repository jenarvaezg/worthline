/**
 * Integration tests for the Numista connected-source actions via the `_store`
 * injection seam (PRD #160 / #163). connectNumistaAction reads the scope cookie
 * from next/headers, which has no request context here, so it is exercised by its
 * pure helpers (numista-helpers.test.ts) and the store API directly; these tests
 * cover the cookie-free actions: sync's guard and disconnect's cascade.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db/testing";
import { describe, expect, test, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

// Eager sync on connect (#895): connectNumistaAction now fires
// runNumistaCoinRefresh best-effort after connecting. Stub it so the connect
// tests never touch the network (syncNumistaAction is cookie-bound and not
// exercised here; it does not route through this module).
vi.mock("./numista-coin-refresh", () => ({
  runNumistaCoinRefresh: vi.fn(async () => ({ errors: [] })),
}));

import {
  connectNumistaAction,
  disconnectNumistaAction,
  syncNumistaAction,
} from "./numista-actions";
import { runNumistaCoinRefresh } from "./numista-coin-refresh";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

/** Run an action and return the NEXT_REDIRECT digest (the redirect target). */
async function runAction(
  action: (fd: FormData, store: WorthlineStore) => Promise<never>,
  fd: FormData,
  store: WorthlineStore,
): Promise<string> {
  try {
    await action(fd, store);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

async function seedWithSource(
  store: WorthlineStore,
): Promise<{ sourceId: string; assetId: string }> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  return store.connectedSources.connect({
    adapter: "numista",
    label: "Colección Numista",
    credentialsJson: JSON.stringify({ apiKey: "secret" }),
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
}

describe("connectNumistaAction", () => {
  test("connects the first Numista source and eagerly syncs it (#895)", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    vi.mocked(runNumistaCoinRefresh).mockClear();

    const digest = await runAction(
      connectNumistaAction,
      form({ currentUrl: "/ajustes", apiKey: "the-key" }),
      store,
    );

    expect(digest).toContain("ok=numista_connected");
    const sources = await store.connectedSources.listSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.adapter).toBe("numista");
    expect(JSON.parse(sources[0]!.credentialsJson)).toEqual({ apiKey: "the-key" });
    // The connect fires exactly one eager refresh so the collection shows coins
    // before the next cron (the GET is cache-only now).
    expect(runNumistaCoinRefresh).toHaveBeenCalledTimes(1);
  });

  test("refuses a second Numista source", async () => {
    const store = await createInMemoryStore();
    await seedWithSource(store);

    const digest = await runAction(
      connectNumistaAction,
      form({ currentUrl: "/ajustes", apiKey: "another" }),
      store,
    );

    expect(digest).toContain("error=");
    expect(await store.connectedSources.listSources()).toHaveLength(1);
  });
});

describe("disconnectNumistaAction", () => {
  test("removes the source, its positions, and the projected holding (cascade)", async () => {
    const store = await createInMemoryStore();
    const { sourceId, assetId } = await seedWithSource(store);

    // Give it a position so we can prove the cascade also clears positions.
    await store.connectedSources.syncPositions(
      sourceId,
      [
        {
          kind: "coin",
          catalogueId: "1",
          externalId: "ni-1",
          issueId: null,
          name: "20 francos",
          grade: "EBC",
          quantity: 1,
          year: null,
          liquidityTier: "illiquid",
          metal: "gold",
          finenessMillis: null,
          weightGrams: null,
          purchaseDate: null,
          metalValueMinor: 35_000,
          numismaticValueMinor: null,
          numismaticFetchedAt: null,
          purchasePriceMinor: null,
          obverseThumbUrl: null,
          currency: "EUR",
        },
      ],
      "2026-06-14T10:00:00.000Z",
    );

    expect(await store.connectedSources.listSources()).toHaveLength(1);
    expect((await store.assets.readAssets()).some((a) => a.id === assetId)).toBe(true);

    const digest = await runAction(
      disconnectNumistaAction,
      form({ currentUrl: "/ajustes", sourceId }),
      store,
    );

    expect(digest).toContain("ok=numista_disconnected");
    expect(await store.connectedSources.listSources()).toHaveLength(0);
    expect(await store.connectedSources.readSource(sourceId)).toBeNull();
    expect((await store.assets.readAssets()).some((a) => a.id === assetId)).toBe(false);
  });

  test("errors when no source id is supplied", async () => {
    const store = await createInMemoryStore();
    await seedWithSource(store);

    const digest = await runAction(
      disconnectNumistaAction,
      form({ currentUrl: "/ajustes" }),
      store,
    );

    expect(digest).toContain("error=");
    expect(await store.connectedSources.listSources()).toHaveLength(1);
  });

  test("mode=remove still removes the live holding (the default path)", async () => {
    const store = await createInMemoryStore();
    const { sourceId, assetId } = await seedWithSource(store);

    const digest = await runAction(
      disconnectNumistaAction,
      form({ currentUrl: "/ajustes", sourceId, mode: "remove" }),
      store,
    );

    expect(digest).toContain("ok=numista_disconnected");
    expect(await store.connectedSources.listSources()).toHaveLength(0);
    expect((await store.assets.readAssets()).some((a) => a.id === assetId)).toBe(false);
  });

  test("mode=freeze keeps the asset as a hand-valued holding and drops the source", async () => {
    const store = await createInMemoryStore();
    const { sourceId, assetId } = await seedWithSource(store);
    await store.connectedSources.syncPositions(
      sourceId,
      [
        {
          kind: "coin",
          catalogueId: "1",
          externalId: "ni-1",
          issueId: null,
          name: "20 francos",
          grade: "EBC",
          quantity: 1,
          year: null,
          liquidityTier: "illiquid",
          metal: "gold",
          finenessMillis: null,
          weightGrams: null,
          purchaseDate: null,
          metalValueMinor: 35_000,
          numismaticValueMinor: null,
          numismaticFetchedAt: null,
          purchasePriceMinor: null,
          obverseThumbUrl: null,
          currency: "EUR",
        },
      ],
      "2026-06-14T10:00:00.000Z",
    );

    const digest = await runAction(
      disconnectNumistaAction,
      form({ currentUrl: "/ajustes", sourceId, mode: "freeze" }),
      store,
    );

    expect(digest).toContain("ok=numista_frozen");
    // The source is gone, but the asset survives as a hand-valued precious-metal
    // holding keeping its frozen value.
    expect(await store.connectedSources.listSources()).toHaveLength(0);
    const frozen = (await store.assets.readAssets()).find((a) => a.id === assetId);
    expect(frozen?.instrument).toBe("precious_metal");
    expect(frozen?.currentValue.amountMinor).toBe(35_000);
  });
});

describe("syncNumistaAction", () => {
  test("falls back to a local redirect when currentUrl is absolute", async () => {
    const store = await createInMemoryStore();
    await seedWithSource(store);

    const digest = await runAction(
      syncNumistaAction,
      form({ currentUrl: "https://evil.example/steal", sourceId: "missing" }),
      store,
    );

    expect(digest).toContain(";replace;/ajustes?error=");
    expect(digest).not.toContain("evil.example");
  });

  test("errors (without wiping positions) when the source id is unknown", async () => {
    const store = await createInMemoryStore();
    const { sourceId } = await seedWithSource(store);
    await store.connectedSources.syncPositions(
      sourceId,
      [
        {
          kind: "coin",
          catalogueId: "1",
          externalId: "ni-1",
          issueId: null,
          name: "Soberano",
          grade: "MBC",
          quantity: 1,
          year: null,
          liquidityTier: "illiquid",
          metal: "gold",
          finenessMillis: null,
          weightGrams: null,
          purchaseDate: null,
          metalValueMinor: 50_000,
          numismaticValueMinor: null,
          numismaticFetchedAt: null,
          purchasePriceMinor: null,
          obverseThumbUrl: null,
          currency: "EUR",
        },
      ],
      "2026-06-14T10:00:00.000Z",
    );

    const digest = await runAction(
      syncNumistaAction,
      form({ currentUrl: "/ajustes", sourceId: "missing" }),
      store,
    );

    expect(digest).toContain("error=");
    // The real source's positions are untouched.
    expect(await store.connectedSources.readPositions(sourceId)).toHaveLength(1);
  });
});
