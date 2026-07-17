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
  return { close, openAuthorizedStore };
});

vi.mock("next/server", () => ({
  after: (callback: () => void) => {
    afterCallbacks.push(callback);
  },
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

import { getRequestStore } from "./store";

describe("getRequestStore", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    mocks.close.mockClear();
    mocks.openAuthorizedStore.mockClear();
    mocks.openAuthorizedStore.mockResolvedValue({ close: mocks.close });
  });

  test("opens the store and defers close to after()", async () => {
    await getRequestStore();

    expect(mocks.openAuthorizedStore).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);

    afterCallbacks[0]!();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
