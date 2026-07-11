import { beforeEach, describe, expect, test, vi } from "vitest";

const afterCallbacks: Array<() => void> = [];

const mocks = vi.hoisted(() => {
  const close = vi.fn();
  const openStore = vi.fn(async () => ({ close }));
  return { close, openStore };
});

vi.mock("next/server", () => ({
  after: (callback: () => void) => {
    afterCallbacks.push(callback);
  },
}));

vi.mock("./read-store-target", () => ({
  readStoreTarget: vi.fn(async () => ({
    kind: "local",
  })),
}));

vi.mock("./store", () => ({
  openStore: mocks.openStore,
}));

import { getRequestStore } from "./request-store";

describe("getRequestStore", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    mocks.close.mockClear();
    mocks.openStore.mockClear();
    mocks.openStore.mockResolvedValue({ close: mocks.close });
  });

  test("opens the store and defers close to after()", async () => {
    await getRequestStore();

    expect(mocks.openStore).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);

    afterCallbacks[0]!();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
