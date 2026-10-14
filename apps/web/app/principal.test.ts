import { SCHEMA_VERSION, WorkspaceSchemaBehindError } from "@worthline/db";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const authClose = vi.fn();
  const demoClose = vi.fn();
  const createWorthlineStoreUnsafe = vi.fn(
    async (_options?: unknown) => ({ close: authClose, tag: "unsafe" }) as never,
  );
  const getDemoStore = vi.fn(async () => ({ close: demoClose, tag: "demo" }) as never);
  const getWorkspaceWithOwner = vi.fn(
    async (_workspaceId: string): Promise<unknown> => null,
  );
  const controlPlaneClose = vi.fn();
  return {
    authClose,
    controlPlaneClose,
    createWorthlineStoreUnsafe,
    demoClose,
    getDemoStore,
    getWorkspaceWithOwner,
  };
});

vi.mock("@worthline/db/unsafe-store", () => ({
  createWorthlineStoreUnsafe: mocks.createWorthlineStoreUnsafe,
}));
vi.mock("./control-plane-store", () => ({
  withControlPlaneStore: async (run: (store: unknown) => unknown) => {
    try {
      return await run({ getWorkspaceWithOwner: mocks.getWorkspaceWithOwner });
    } finally {
      mocks.controlPlaneClose();
    }
  },
}));
vi.mock("@web/demo/store-provider", () => ({
  getDemoStore: mocks.getDemoStore,
}));
vi.mock("@web/demo/demo-clock", () => ({
  demoAsOfDateKey: () => "2026-07-16",
}));

import { openAuthorizedStore, type Principal, withAuthorizedStore } from "./principal";

describe("authorization port", () => {
  beforeEach(() => {
    mocks.authClose.mockClear();
    mocks.demoClose.mockClear();
    mocks.createWorthlineStoreUnsafe.mockClear();
    mocks.getDemoStore.mockClear();
    mocks.getWorkspaceWithOwner.mockClear();
  });

  test("authenticated principal opens the workspace DB with its url + token", async () => {
    const principal: Principal = {
      kind: "authenticated",
      workspaceId: "wl-1",
      dbUrl: "libsql://wl-1.turso.io",
      token: "group-token",
    };

    await openAuthorizedStore(principal);

    expect(mocks.createWorthlineStoreUnsafe).toHaveBeenCalledWith({
      authToken: "group-token",
      url: "libsql://wl-1.turso.io",
    });
    expect(mocks.getDemoStore).not.toHaveBeenCalled();
  });

  test("local principal opens the env-configured single-user store", async () => {
    await openAuthorizedStore({ kind: "local" });

    expect(mocks.createWorthlineStoreUnsafe).toHaveBeenCalledWith();
  });

  test("system principal opens with the coordinates it carries", async () => {
    await openAuthorizedStore({
      kind: "system",
      options: { url: "libsql://cron.turso.io", authToken: "t" },
    });

    expect(mocks.createWorthlineStoreUnsafe).toHaveBeenCalledWith({
      url: "libsql://cron.turso.io",
      authToken: "t",
    });
  });

  test("demo principal opens the seeded demo store", async () => {
    await openAuthorizedStore({ kind: "demo", persona: "familia", now: "" });

    expect(mocks.getDemoStore).toHaveBeenCalledTimes(1);
    expect(mocks.createWorthlineStoreUnsafe).not.toHaveBeenCalled();
  });

  test("withAuthorizedStore closes a real store after the unit of work", async () => {
    const seen: unknown[] = [];
    await withAuthorizedStore({ kind: "local" }, (store) => {
      seen.push(store);
    });

    expect(seen).toHaveLength(1);
    expect(mocks.authClose).toHaveBeenCalledTimes(1);
  });

  test("demo store survives the unit of work (close is a no-op)", async () => {
    await withAuthorizedStore({ kind: "demo", persona: "familia", now: "" }, () => {});

    // The cached demo store lives for the process; the port must not tear it down.
    expect(mocks.demoClose).not.toHaveBeenCalled();
  });

  test("an owner (no sharedByEmail) opens with full access and never touches the control plane", async () => {
    await openAuthorizedStore({
      kind: "authenticated",
      workspaceId: "wl-1",
      dbUrl: "libsql://wl-1.turso.io",
      token: "owner-token",
    });

    expect(mocks.createWorthlineStoreUnsafe).toHaveBeenCalledTimes(1);
    expect(mocks.createWorthlineStoreUnsafe.mock.calls[0]?.[0]).not.toHaveProperty(
      "readOnly",
    );
    expect(mocks.getWorkspaceWithOwner).not.toHaveBeenCalled();
  });
});

describe("authorization port · viewer principal (#1842)", () => {
  const viewer: Principal = {
    kind: "authenticated",
    workspaceId: "wl-owner",
    dbUrl: "libsql://wl-owner.turso.io",
    token: "viewer-ro-token",
    sharedByEmail: "jorge@example.com",
  };
  const VIEWER_OPEN = {
    authToken: "viewer-ro-token",
    readOnly: true,
    url: "libsql://wl-owner.turso.io",
  };
  const OWNER_ROW = {
    createdAt: "2026-07-01T00:00:00.000Z",
    dbAuthToken: "owner-full-token",
    dbName: "wl-owner",
    dbUrl: "libsql://wl-owner.turso.io",
    id: "wl-owner",
    ownerEmail: "jorge@example.com",
  };

  beforeEach(() => {
    mocks.authClose.mockClear();
    mocks.createWorthlineStoreUnsafe.mockReset();
    mocks.createWorthlineStoreUnsafe.mockImplementation(
      async (options?: unknown) =>
        ({ close: mocks.authClose, opened: options, tag: "unsafe" }) as never,
    );
    mocks.getWorkspaceWithOwner.mockReset();
    mocks.getWorkspaceWithOwner.mockResolvedValue(OWNER_ROW);
    mocks.controlPlaneClose.mockClear();
  });

  test("opens read-only with its own token, with nothing else on the options", async () => {
    const store = await openAuthorizedStore(viewer);

    expect(mocks.createWorthlineStoreUnsafe).toHaveBeenCalledTimes(1);
    expect(mocks.createWorthlineStoreUnsafe).toHaveBeenCalledWith(VIEWER_OPEN);
    expect((store as unknown as { opened: unknown }).opened).toEqual(VIEWER_OPEN);
  });

  test("a base at version never reads the control plane", async () => {
    await openAuthorizedStore(viewer);

    expect(mocks.getWorkspaceWithOwner).not.toHaveBeenCalled();
  });

  test("a base behind: control-plane read, a full-access system open, one read-only retry", async () => {
    mocks.createWorthlineStoreUnsafe.mockImplementationOnce(async () => {
      throw new WorkspaceSchemaBehindError(SCHEMA_VERSION - 1);
    });

    const store = await openAuthorizedStore(viewer);

    expect(mocks.getWorkspaceWithOwner).toHaveBeenCalledWith("wl-owner");
    expect(mocks.controlPlaneClose).toHaveBeenCalledTimes(1);
    expect(mocks.createWorthlineStoreUnsafe.mock.calls.map((call) => call[0])).toEqual([
      VIEWER_OPEN,
      { authToken: "owner-full-token", url: "libsql://wl-owner.turso.io" },
      VIEWER_OPEN,
    ]);
    // The maintenance store is closed; the one handed back is the read-only retry.
    expect(mocks.authClose).toHaveBeenCalledTimes(1);
    expect((store as unknown as { opened: unknown }).opened).toEqual(VIEWER_OPEN);
  });

  test("the full token never reaches the store handed back, nor the principal", async () => {
    mocks.createWorthlineStoreUnsafe.mockImplementationOnce(async () => {
      throw new WorkspaceSchemaBehindError(SCHEMA_VERSION - 1);
    });
    const before = JSON.stringify(viewer);

    const store = await openAuthorizedStore(viewer);

    expect(JSON.stringify(viewer)).toBe(before);
    expect(
      JSON.stringify((store as unknown as { opened: unknown }).opened),
    ).not.toContain("owner-full-token");
  });

  test("still behind after the maintenance: throws, no second maintenance", async () => {
    mocks.createWorthlineStoreUnsafe.mockImplementation(async (options?: unknown) => {
      if ((options as { readOnly?: true }).readOnly) {
        throw new WorkspaceSchemaBehindError(SCHEMA_VERSION - 1);
      }
      return { close: mocks.authClose, tag: "unsafe" } as never;
    });

    await expect(openAuthorizedStore(viewer)).rejects.toBeInstanceOf(
      WorkspaceSchemaBehindError,
    );
    expect(mocks.getWorkspaceWithOwner).toHaveBeenCalledTimes(1);
    expect(mocks.createWorthlineStoreUnsafe).toHaveBeenCalledTimes(3);
  });

  test("a control-plane failure throws, with no fallback open of any kind", async () => {
    mocks.createWorthlineStoreUnsafe.mockImplementationOnce(async () => {
      throw new WorkspaceSchemaBehindError(SCHEMA_VERSION - 1);
    });
    mocks.getWorkspaceWithOwner.mockRejectedValueOnce(new Error("control plane down"));

    await expect(openAuthorizedStore(viewer)).rejects.toThrow("control plane down");
    expect(mocks.createWorthlineStoreUnsafe).toHaveBeenCalledTimes(1);
  });

  test("an unknown workspace in the control plane throws, with no fallback open", async () => {
    mocks.createWorthlineStoreUnsafe.mockImplementationOnce(async () => {
      throw new WorkspaceSchemaBehindError(SCHEMA_VERSION - 1);
    });
    mocks.getWorkspaceWithOwner.mockResolvedValueOnce(null);

    await expect(openAuthorizedStore(viewer)).rejects.toThrow();
    expect(mocks.createWorthlineStoreUnsafe).toHaveBeenCalledTimes(1);
  });

  test("any other open failure propagates untouched, with no maintenance", async () => {
    mocks.createWorthlineStoreUnsafe.mockImplementationOnce(async () => {
      throw new Error("network");
    });

    await expect(openAuthorizedStore(viewer)).rejects.toThrow("network");
    expect(mocks.getWorkspaceWithOwner).not.toHaveBeenCalled();
    expect(mocks.createWorthlineStoreUnsafe).toHaveBeenCalledTimes(1);
  });
});

describe("authorization port · type guarantees", () => {
  test("a store cannot be opened without a principal (type-level guarantee)", () => {
    // @ts-expect-error - openAuthorizedStore requires a Principal by value;
    // there is no code path to a workspace store without one (PRD #998 S1).
    const call = () => openAuthorizedStore();
    expect(typeof call).toBe("function");
  });
});
