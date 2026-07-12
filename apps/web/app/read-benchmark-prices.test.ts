import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const readBenchmarkPricesMock = vi.fn();
const closeMock = vi.fn();
const createControlPlaneStoreMock = vi.fn(async (_options?: unknown) => ({
  readBenchmarkPrices: readBenchmarkPricesMock,
  close: closeMock,
}));

const unstableCacheMock = vi.fn(
  (fn: (seriesId: string) => Promise<unknown>, keyParts: string[], options: unknown) =>
    fn,
);

let lastUnstableCacheKeyParts: string[] | undefined;
let lastUnstableCacheOptions: unknown;

vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: (seriesId: string) => Promise<unknown>,
    keyParts: string[],
    options: unknown,
  ) => {
    lastUnstableCacheKeyParts = keyParts;
    lastUnstableCacheOptions = options;
    return unstableCacheMock(fn, keyParts, options);
  },
}));

vi.mock("@worthline/db", () => ({
  createControlPlaneStore: (options: unknown) => createControlPlaneStoreMock(options),
}));

describe("readBenchmarkPricesFromControlPlane", () => {
  beforeEach(() => {
    vi.resetModules();
    readBenchmarkPricesMock.mockReset();
    closeMock.mockReset();
    createControlPlaneStoreMock.mockClear();
    unstableCacheMock.mockClear();
    lastUnstableCacheKeyParts = undefined;
    lastUnstableCacheOptions = undefined;
    delete process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
    delete process.env.WORTHLINE_DB_AUTH_TOKEN;
  });

  afterEach(() => {
    delete process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
    delete process.env.WORTHLINE_DB_AUTH_TOKEN;
  });

  test("returns [] when the control plane URL is unset", async () => {
    const { readBenchmarkPricesFromControlPlane } = await import(
      "./read-benchmark-prices"
    );

    await expect(readBenchmarkPricesFromControlPlane("ipc-es")).resolves.toEqual([]);
    expect(createControlPlaneStoreMock).not.toHaveBeenCalled();
  });

  test("reads benchmark prices from the control plane and closes the store", async () => {
    process.env.WORTHLINE_CONTROL_PLANE_DB_URL = "libsql://control-plane";
    process.env.WORTHLINE_DB_AUTH_TOKEN = "token";
    readBenchmarkPricesMock.mockResolvedValue([
      { seriesId: "ipc-es", dateKey: "2024-01", value: "120.5" },
    ]);

    const { readBenchmarkPricesFromControlPlane } = await import(
      "./read-benchmark-prices"
    );
    const prices = await readBenchmarkPricesFromControlPlane("ipc-es");

    expect(prices).toEqual([{ seriesId: "ipc-es", dateKey: "2024-01", value: "120.5" }]);
    expect(createControlPlaneStoreMock).toHaveBeenCalledWith({
      url: "libsql://control-plane",
      authToken: "token",
    });
    expect(readBenchmarkPricesMock).toHaveBeenCalledWith("ipc-es");
    expect(closeMock).toHaveBeenCalledOnce();
  });

  test("wraps the reader in a 24h global cache keyed by seriesId", async () => {
    process.env.WORTHLINE_CONTROL_PLANE_DB_URL = "libsql://control-plane";
    readBenchmarkPricesMock.mockResolvedValue([]);

    const { readBenchmarkPricesFromControlPlane } = await import(
      "./read-benchmark-prices"
    );
    await readBenchmarkPricesFromControlPlane("msci-world-tr");

    expect(unstableCacheMock).toHaveBeenCalledOnce();
    expect(lastUnstableCacheKeyParts).toEqual(["benchmark-prices"]);
    expect(lastUnstableCacheOptions).toEqual({ revalidate: 86_400 });
  });

  test("falls back to the uncached reader when Next incremental cache is unavailable", async () => {
    process.env.WORTHLINE_CONTROL_PLANE_DB_URL = "libsql://control-plane";
    readBenchmarkPricesMock.mockResolvedValue([
      { seriesId: "ipc-es", dateKey: "2024-01", value: "100" },
    ]);
    unstableCacheMock.mockImplementation(() => async () => {
      throw Object.assign(
        new Error("Invariant: incrementalCache missing in unstable_cache"),
        {
          __NEXT_ERROR_CODE: "E469",
        },
      );
    });

    const { readBenchmarkPricesFromControlPlane } = await import(
      "./read-benchmark-prices"
    );
    const prices = await readBenchmarkPricesFromControlPlane("ipc-es");

    expect(prices).toEqual([{ seriesId: "ipc-es", dateKey: "2024-01", value: "100" }]);
    expect(createControlPlaneStoreMock).toHaveBeenCalledOnce();
  });
});
