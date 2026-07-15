import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const readGlobalExposureProfiles = vi.fn();
  const close = vi.fn();
  const createControlPlaneStore = vi.fn(async (_options?: unknown) => ({
    readGlobalExposureProfiles,
    close,
  }));
  return { readGlobalExposureProfiles, close, createControlPlaneStore };
});

vi.mock("@worthline/db", () => ({
  createControlPlaneStore: (options: unknown) => mocks.createControlPlaneStore(options),
}));

import { readExposureCatalogFromControlPlane } from "./read-exposure-catalog";

describe("readExposureCatalogFromControlPlane (#711 S3)", () => {
  beforeEach(() => {
    mocks.readGlobalExposureProfiles.mockReset();
    mocks.close.mockReset();
    mocks.createControlPlaneStore.mockClear();
    delete process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
    delete process.env.WORTHLINE_DB_AUTH_TOKEN;
  });

  test("no control-plane URL resolves not_configured without opening a store", async () => {
    await expect(readExposureCatalogFromControlPlane()).resolves.toEqual({
      status: "unavailable",
      reason: "not_configured",
    });
    expect(mocks.createControlPlaneStore).not.toHaveBeenCalled();
  });

  test("resolves available with the catalog rows and closes the store", async () => {
    process.env.WORTHLINE_CONTROL_PLANE_DB_URL = "libsql://control-plane";
    const rows = [{ identity: { kind: "isin", isin: "IE00B4L5Y983" } }];
    mocks.readGlobalExposureProfiles.mockResolvedValue(rows);

    await expect(readExposureCatalogFromControlPlane()).resolves.toEqual({
      status: "available",
      profiles: rows,
    });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  test("a read failure degrades to read_failed and still closes the store", async () => {
    process.env.WORTHLINE_CONTROL_PLANE_DB_URL = "libsql://control-plane";
    mocks.readGlobalExposureProfiles.mockRejectedValue(new Error("boom"));

    await expect(readExposureCatalogFromControlPlane()).resolves.toEqual({
      status: "unavailable",
      reason: "read_failed",
    });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  test("an open failure degrades to read_failed (never a bare empty catalog)", async () => {
    process.env.WORTHLINE_CONTROL_PLANE_DB_URL = "libsql://control-plane";
    mocks.createControlPlaneStore.mockRejectedValueOnce(new Error("cannot connect"));

    await expect(readExposureCatalogFromControlPlane()).resolves.toEqual({
      status: "unavailable",
      reason: "read_failed",
    });
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
