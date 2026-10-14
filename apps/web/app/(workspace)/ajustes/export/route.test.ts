/**
 * The export refuses a viewer (#1843, ADR 0112): it is the whole workspace in one
 * file, the owner's copy, and it would outlive a revocation. 403, and the store is
 * never opened.
 */

import type { StoreTarget } from "@web/store-resolver";
import { createInMemoryStore } from "@worthline/db/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ store: null as unknown, target: null as unknown }));

vi.mock("@web/read-store-target", () => ({
  readStoreTarget: async () => state.target,
}));
vi.mock("@web/store", () => ({
  withStore: vi.fn(async (run: (store: unknown) => unknown) => run(state.store)),
}));

import { withStore } from "@web/store";

import { GET } from "./route";

const OWN: StoreTarget = {
  kind: "authenticated",
  workspaceId: "ws-jorge",
  dbUrl: "libsql://wl-jorge.turso.io",
  token: "full-jorge",
};
const VIEWER: StoreTarget = {
  ...OWN,
  token: "read-only-jorge",
  sharedByEmail: "jorge@example.com",
};

beforeEach(async () => {
  vi.mocked(withStore).mockClear();
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Jorge" }],
    mode: "individual",
  });
  state.store = store;
});

describe("GET /ajustes/export", () => {
  test("a viewer gets 403 and the store is never opened", async () => {
    state.target = VIEWER;

    const response = await GET();

    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe(
      "La exportación es solo para quien es dueño del espacio. Con acceso de solo lectura puedes ver sus cifras aquí, pero no descargarlas.",
    );
    expect(withStore).not.toHaveBeenCalled();
  });

  test("the owner still downloads the workspace", async () => {
    state.target = OWN;

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
  });
});
