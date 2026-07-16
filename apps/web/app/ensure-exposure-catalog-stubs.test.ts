import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const ensureGlobalExposureProfileStub = vi.fn(async () => {});
  const close = vi.fn();
  const createControlPlaneStore = vi.fn(async (_options?: unknown) => ({
    close,
    ensureGlobalExposureProfileStub,
  }));
  return { close, createControlPlaneStore, ensureGlobalExposureProfileStub };
});

vi.mock("@worthline/db", () => ({
  createControlPlaneStore: (options: unknown) => mocks.createControlPlaneStore(options),
}));

import { ensureExposureCatalogStubs } from "./ensure-exposure-catalog-stubs";

const VWRL_ISIN = "IE00B3RBWM25";

describe("ensureExposureCatalogStubs (#1097)", () => {
  beforeEach(() => {
    mocks.ensureGlobalExposureProfileStub.mockReset();
    mocks.ensureGlobalExposureProfileStub.mockResolvedValue(undefined);
    mocks.close.mockReset();
    mocks.createControlPlaneStore.mockClear();
    mocks.createControlPlaneStore.mockResolvedValue({
      close: mocks.close,
      ensureGlobalExposureProfileStub: mocks.ensureGlobalExposureProfileStub,
    });
    process.env.WORTHLINE_CONTROL_PLANE_DB_URL = "libsql://control-plane";
  });

  test("no control-plane URL is a silent no-op (never opens a store)", async () => {
    delete process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
    await ensureExposureCatalogStubs([{ instrument: "fund", isin: VWRL_ISIN }]);
    expect(mocks.createControlPlaneStore).not.toHaveBeenCalled();
  });

  test("registers a stub for a market holding with the derived identity", async () => {
    await ensureExposureCatalogStubs([
      { displayName: "MSCI World", instrument: "fund", isin: VWRL_ISIN },
    ]);
    expect(mocks.ensureGlobalExposureProfileStub).toHaveBeenCalledTimes(1);
    expect(mocks.ensureGlobalExposureProfileStub).toHaveBeenCalledWith(
      { isin: VWRL_ISIN, kind: "isin" },
      "MSCI World",
    );
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  test("dedupes identical identities so one holding is registered once", async () => {
    await ensureExposureCatalogStubs([
      { displayName: "A", instrument: "fund", isin: VWRL_ISIN },
      { displayName: "B", instrument: "etf", isin: VWRL_ISIN },
    ]);
    expect(mocks.ensureGlobalExposureProfileStub).toHaveBeenCalledTimes(1);
  });

  test("skips non-market holdings entirely (never opens a store)", async () => {
    await ensureExposureCatalogStubs([
      { instrument: "property", isin: VWRL_ISIN },
      { instrument: "crypto", providerSymbol: "BTC" },
    ]);
    expect(mocks.createControlPlaneStore).not.toHaveBeenCalled();
    expect(mocks.ensureGlobalExposureProfileStub).not.toHaveBeenCalled();
  });

  test("best-effort: an open failure never throws to the caller", async () => {
    mocks.createControlPlaneStore.mockRejectedValueOnce(new Error("cannot connect"));
    await expect(
      ensureExposureCatalogStubs([{ instrument: "fund", isin: VWRL_ISIN }]),
    ).resolves.toBeUndefined();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  test("best-effort: one identity failing does not abort the rest, and always closes", async () => {
    mocks.ensureGlobalExposureProfileStub
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce(undefined);
    await expect(
      ensureExposureCatalogStubs([
        { instrument: "fund", isin: VWRL_ISIN },
        { instrument: "stock", priceProvider: "yahoo", providerSymbol: "AAPL" },
      ]),
    ).resolves.toBeUndefined();
    expect(mocks.ensureGlobalExposureProfileStub).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
