import { beforeEach, describe, expect, test, vi } from "vitest";

import type { WorthlineStore } from "@worthline/db";

/**
 * Unit tests for the shared `_store?` action seam (issue #481). `withStore` is
 * mocked so the no-store path is observable without opening a real DB: the seam's
 * only job is the branch — use the injected test store directly, else delegate to
 * the demo/auth/local-resolving `withStore`. Demo handling lives in `withStore`
 * (here asserted via delegation); injection is the bypass.
 */

const withStoreMock = vi.fn();

vi.mock("@web/store", () => ({
  withStore: (fn: (store: WorthlineStore) => unknown) => withStoreMock(fn),
}));

import { runActionWithStore } from "./action-store";

function fakeStore(): WorthlineStore & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn(), tag: "injected" } as unknown as WorthlineStore & {
    close: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  withStoreMock.mockReset();
});

describe("runActionWithStore", () => {
  test("runs the fn against the injected store, never opening a new one", async () => {
    const store = fakeStore();
    const received: WorthlineStore[] = [];

    const result = await runActionWithStore((s) => {
      received.push(s);
      return "done";
    }, store);

    expect(result).toBe("done");
    expect(received).toEqual([store]);
    expect(withStoreMock).not.toHaveBeenCalled();
  });

  test("does not close the injected store (the caller/test owns its lifecycle)", async () => {
    const store = fakeStore();

    await runActionWithStore(async () => "ok", store);

    expect(store.close).not.toHaveBeenCalled();
  });

  test("delegates to withStore when no store is injected (demo/auth/local resolution)", async () => {
    withStoreMock.mockResolvedValue("from-withStore");
    const fn = async (s: WorthlineStore) => s;

    const result = await runActionWithStore(fn);

    expect(result).toBe("from-withStore");
    expect(withStoreMock).toHaveBeenCalledTimes(1);
    expect(withStoreMock).toHaveBeenCalledWith(fn);
  });

  test("wraps a synchronous fn result in a promise on the injected path", async () => {
    const store = fakeStore();

    const ret = runActionWithStore(() => 42, store);

    expect(ret).toBeInstanceOf(Promise);
    expect(await ret).toBe(42);
  });

  test("propagates the resolved value of an async fn on the injected path", async () => {
    const store = fakeStore();

    await expect(runActionWithStore(async () => ({ n: 1 }), store)).resolves.toEqual({
      n: 1,
    });
  });

  test("a synchronous throw on the injected path propagates synchronously, as the old closures did", () => {
    // Real actions pass async arrows (which reject, never throw sync), but this
    // pins parity with the replaced `_store ? fn(_store) : ...` closures: `fn` is
    // evaluated before `Promise.resolve` wraps it, so a sync throw is a sync throw.
    const store = fakeStore();

    expect(() =>
      runActionWithStore(() => {
        throw new Error("boom");
      }, store),
    ).toThrow("boom");
  });
});
