/**
 * The live steps of a MyInvestor pass (#1884): the panel polls the step the pass
 * wrote down. Only the session's own workspace, and nothing but a step and an hour.
 */
import type { StoreTarget } from "@web/store-resolver";
import { createInMemoryStore, type PersistenceTestStore } from "@worthline/db/testing";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

let mockTarget: StoreTarget = { kind: "local" };
let store: PersistenceTestStore;

vi.mock("@web/read-store-target", () => ({
  readStoreTarget: async () => mockTarget,
}));
vi.mock("@web/store", () => ({
  withStore: async (run: (opened: PersistenceTestStore) => unknown) => run(store),
}));

import { GET } from "./route";

function request(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/myinvestor/progress${query}`);
}

beforeEach(async () => {
  mockTarget = { kind: "local" };
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Titular" }],
    mode: "individual",
  });
});

describe("GET /api/myinvestor/progress", () => {
  test("the step of the pass that holds the connection, and nothing once it is free", async () => {
    const { sourceId } = (await store.connectedSources.connectOwningSource({
      adapter: "myinvestor",
      credentialsJson: "{}",
      label: "MyInvestor",
    }))!;
    const startedAt = new Date().toISOString();
    await store.connectedSources.claimSyncLease({
      now: startedAt,
      sourceId,
      trigger: "cron",
      until: new Date(Date.now() + 600_000).toISOString(),
    });
    await store.connectedSources.setSyncStep(sourceId, "orders");

    const running = await GET(request(`?sourceId=${sourceId}`));
    expect(await running.json()).toEqual({ running: true, startedAt, step: "orders" });

    await store.connectedSources.releaseSyncLease(sourceId);
    const free = await GET(request(`?sourceId=${sourceId}`));
    expect(await free.json()).toEqual({ running: false, startedAt: null, step: null });
  });

  test("no session, no answer; no source id, a bad request", async () => {
    expect((await GET(request(""))).status).toBe(400);
    mockTarget = { kind: "unauthenticated" } as StoreTarget;
    expect((await GET(request("?sourceId=x"))).status).toBe(401);
  });
});
