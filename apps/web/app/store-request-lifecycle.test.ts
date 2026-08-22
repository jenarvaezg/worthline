import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `getRequestStore` lifecycle (#1025). This is the request-scoped store seam's
 * `after()` close policy — one libSQL connection per RSC request, closed after
 * the response. It now lives in the single store module (`./store`), no longer
 * in a separate `request-store.ts`, and reaches the connection through the same
 * authorization port (`openAuthorizedStore`) as every other opener.
 */

const afterCallbacks: Array<() => void> = [];

const mocks = vi.hoisted(() => {
  const close = vi.fn();
  const openAuthorizedStore = vi.fn(async () => ({ close }));
  const perfStart = vi.fn(() => 10);
  const perfEnd = vi.fn();
  const requestPath = { value: null as string | null };
  return { close, openAuthorizedStore, perfEnd, perfStart, requestPath };
});

vi.mock("next/server", () => ({
  after: (callback: () => void) => {
    afterCallbacks.push(callback);
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) =>
      name === "x-pathname" || name === "x-matched-path" ? mocks.requestPath.value : null,
  }),
}));

// Stub only the request read; keep the REAL `isReachable` so this test never
// re-encodes the guard it is exercising (it would silently drift otherwise).
vi.mock("./read-store-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./read-store-target")>()),
  readStoreTarget: vi.fn(async () => ({ kind: "local" })),
}));

vi.mock("./principal", () => ({
  openAuthorizedStore: mocks.openAuthorizedStore,
}));

vi.mock("./perf-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./perf-log")>()),
  perfEnd: mocks.perfEnd,
  perfStart: mocks.perfStart,
}));

import { getRequestStore } from "./store";

describe("getRequestStore", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    mocks.close.mockClear();
    mocks.openAuthorizedStore.mockClear();
    mocks.openAuthorizedStore.mockResolvedValue({ close: mocks.close });
    mocks.perfStart.mockClear();
    mocks.perfEnd.mockClear();
    mocks.requestPath.value = null;
  });

  test("opens the store, logs store-open duration, and defers close to after() (#1538)", async () => {
    await getRequestStore();

    expect(mocks.openAuthorizedStore).toHaveBeenCalledTimes(1);
    expect(mocks.perfEnd).toHaveBeenCalledTimes(1);
    expect(mocks.perfEnd.mock.calls[0]![0]).toMatch(/^store-open/);
    expect(mocks.perfEnd.mock.calls[0]![1]).toBe(10);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);

    afterCallbacks[0]!();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  test("the first process open is store-open:cold; later ones are store-open", async () => {
    vi.resetModules();
    const { openStore } = await import("./store");

    await openStore();
    await openStore();

    expect(mocks.perfEnd.mock.calls.map((call) => call[0])).toEqual([
      "store-open:cold",
      "store-open",
    ]);
  });

  test("the store-open label carries the request path (#1538)", async () => {
    mocks.requestPath.value = "/objetivos";
    vi.resetModules();
    const { openStore } = await import("./store");

    await openStore();

    expect(mocks.perfEnd.mock.calls[0]![0]).toBe("store-open:cold:/objetivos");
  });
});
