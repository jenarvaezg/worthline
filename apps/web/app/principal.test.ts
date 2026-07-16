import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const authClose = vi.fn();
  const demoClose = vi.fn();
  const createWorthlineStoreUnsafe = vi.fn(
    async (_options?: unknown) => ({ close: authClose, tag: "unsafe" }) as never,
  );
  const getDemoStore = vi.fn(async () => ({ close: demoClose, tag: "demo" }) as never);
  return { authClose, createWorthlineStoreUnsafe, demoClose, getDemoStore };
});

vi.mock("@worthline/db", () => ({
  createWorthlineStoreUnsafe: mocks.createWorthlineStoreUnsafe,
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

  test("a store cannot be opened without a principal (type-level guarantee)", () => {
    // @ts-expect-error - openAuthorizedStore requires a Principal by value;
    // there is no code path to a workspace store without one (PRD #998 S1).
    const call = () => openAuthorizedStore();
    expect(typeof call).toBe("function");
  });
});
