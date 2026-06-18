/**
 * Integration tests for the GENERIC connected-source lifecycle (ADR 0027, #319),
 * driven through the `_store` injection seam. They prove Numista's connect/sync/
 * disconnect now go through the one generic seam:
 *   - connect refuses a second Numista source (the "already connected" guard);
 *   - sync calls `adapter.listPositions` and persists the drafts (re-rolling value);
 *   - disconnect forks freeze (flip to hand-valued) vs remove (cascade away).
 *
 * connect reads the scope cookie from next/headers, so `cookies` is mocked. The
 * sync test uses a tiny fake adapter so the persisted value is deterministic and
 * the assertion is about the SEAM (adapter → store), not Numista response parsing
 * (which numista-sync.test.ts already covers); connect/disconnect use the real
 * `numistaAdapter` (they touch no network).
 */

import { createInMemoryStore } from "@worthline/db";
import type { WorthlineStore } from "@worthline/db";
import { numistaAdapter } from "@worthline/pricing";
import type {
  AdapterPositionDraft,
  ConnectedSourceAdapter,
  NumistaCreds,
} from "@worthline/pricing";
import { describe, expect, test, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import {
  connectSource,
  disconnectSource,
  syncSource,
  type SyncWiring,
} from "./connected-source-lifecycle";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

async function runRedirect(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    throw new Error("did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

function seedWithSource(store: WorthlineStore): { sourceId: string; assetId: string } {
  store.workspace.initializeWorkspace({
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

const COIN_DRAFT: AdapterPositionDraft = {
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
};

type NumistaAdapter = typeof numistaAdapter;
type NumistaToken =
  NumistaAdapter extends ConnectedSourceAdapter<NumistaCreds, infer T> ? T : never;

/** A tiny Numista-tagged adapter whose `listPositions` returns fixed drafts, so the
 *  persisted value is deterministic — the seam contract under test. */
const fakeNumistaAdapter: NumistaAdapter = {
  ...numistaAdapter,
  listPositions: async () => [COIN_DRAFT],
};

/** Sync wiring whose `buildContext` is a no-op (the fake adapter ignores it). */
function fakeWiring(): SyncWiring<NumistaCreds, NumistaToken> {
  return {
    notFound: "no source",
    missingCredentials: "no creds",
    syncFailed: "sync failed",
    okParam: "numista_synced",
    parseToken: () => null,
    buildContext: async ({ creds, token, nowIso, nowMs, persistToken }) => ({
      creds,
      token,
      saveToken: persistToken,
      nowIso,
      nowMs,
    }),
  };
}

describe("connectSource (generic) — Numista", () => {
  test("refuses a second Numista source", async () => {
    const store = createInMemoryStore();
    seedWithSource(store);

    const digest = await runRedirect(() =>
      connectSource(
        numistaAdapter,
        form({ currentUrl: "/ajustes", apiKey: "another" }),
        {
          formId: "numista",
          missingCredentials: "missing",
          alreadyConnected: "Ya hay una colección Numista conectada.",
          noOwner: "no owner",
          label: "Colección Numista",
          okParam: "numista_connected",
        },
        store,
      ),
    );

    expect(digest).toContain("error=");
    expect(store.connectedSources.listSources()).toHaveLength(1);
  });

  test("connects the first Numista source", async () => {
    const store = createInMemoryStore();
    store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });

    const digest = await runRedirect(() =>
      connectSource(
        numistaAdapter,
        form({ currentUrl: "/ajustes", apiKey: "the-key" }),
        {
          formId: "numista",
          missingCredentials: "missing",
          alreadyConnected: "already",
          noOwner: "no owner",
          label: "Colección Numista",
          okParam: "numista_connected",
        },
        store,
      ),
    );

    expect(digest).toContain("ok=numista_connected");
    const sources = store.connectedSources.listSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.adapter).toBe("numista");
    // The pasted key is serialized via the adapter into credentialsJson.
    expect(JSON.parse(sources[0]!.credentialsJson)).toEqual({ apiKey: "the-key" });
  });
});

describe("syncSource (generic) — Numista", () => {
  test("calls adapter.listPositions and persists them (re-rolling value)", async () => {
    const store = createInMemoryStore();
    const { sourceId, assetId } = seedWithSource(store);

    const digest = await runRedirect(() =>
      syncSource(fakeNumistaAdapter, sourceId, fakeWiring(), "/ajustes", store),
    );

    expect(digest).toContain("ok=numista_synced");
    expect(store.connectedSources.readPositions(sourceId)).toHaveLength(1);
    const holding = store.assets.readAssets().find((a) => a.id === assetId);
    expect(holding?.currentValue.amountMinor).toBe(35_000);
  });

  test("errors (without wiping positions) when the source id is unknown", async () => {
    const store = createInMemoryStore();
    const { sourceId } = seedWithSource(store);
    store.connectedSources.syncPositions(
      sourceId,
      [COIN_DRAFT],
      "2026-06-14T10:00:00.000Z",
    );

    const digest = await runRedirect(() =>
      syncSource(fakeNumistaAdapter, "missing", fakeWiring(), "/ajustes", store),
    );

    expect(digest).toContain("error=");
    expect(store.connectedSources.readPositions(sourceId)).toHaveLength(1);
  });
});

describe("disconnectSource (generic) — Numista", () => {
  const messages = {
    notFound: "not found",
    freezeFailed: "freeze failed",
    removeFailed: "remove failed",
    frozenParam: "numista_frozen",
    disconnectedParam: "numista_disconnected",
  };

  test("remove drops the source + holding (the default path)", async () => {
    const store = createInMemoryStore();
    const { sourceId, assetId } = seedWithSource(store);

    const digest = await runRedirect(() =>
      disconnectSource(sourceId, false, messages, "/ajustes", store),
    );

    expect(digest).toContain("ok=numista_disconnected");
    expect(store.connectedSources.listSources()).toHaveLength(0);
    expect(store.assets.readAssets().some((a) => a.id === assetId)).toBe(false);
  });

  test("freeze flips the asset to a hand-valued precious-metal holding", async () => {
    const store = createInMemoryStore();
    const { sourceId, assetId } = seedWithSource(store);
    store.connectedSources.syncPositions(
      sourceId,
      [COIN_DRAFT],
      "2026-06-14T10:00:00.000Z",
    );

    const digest = await runRedirect(() =>
      disconnectSource(sourceId, true, messages, "/ajustes", store),
    );

    expect(digest).toContain("ok=numista_frozen");
    expect(store.connectedSources.listSources()).toHaveLength(0);
    const frozen = store.assets.readAssets().find((a) => a.id === assetId);
    expect(frozen?.instrument).toBe("precious_metal");
    expect(frozen?.currentValue.amountMinor).toBe(35_000);
  });
});
