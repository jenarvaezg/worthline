import type { ControlPlaneStore } from "@worthline/db";
import { beforeEach, describe, expect, test, vi } from "vitest";

const afterCallbacks: Array<() => void> = [];

const mocks = vi.hoisted(() => {
  const readGlobalExposureProfiles = vi.fn();
  const readBenchmarkPrices = vi.fn();
  const close = vi.fn();
  const createControlPlaneStore = vi.fn(async (_options?: unknown) => ({
    readGlobalExposureProfiles,
    readBenchmarkPrices,
    close,
  }));
  return {
    readGlobalExposureProfiles,
    readBenchmarkPrices,
    close,
    createControlPlaneStore,
  };
});

vi.mock("next/server", () => ({
  after: (callback: () => void) => {
    afterCallbacks.push(callback);
  },
}));

vi.mock("@worthline/db", () => ({
  createControlPlaneStore: (options: unknown) => mocks.createControlPlaneStore(options),
}));

vi.mock("./read-store-target", () => ({
  readStoreTarget: vi.fn(async () => ({ kind: "local" })),
}));

import {
  createReferenceSessionForTarget,
  getReferenceSession,
} from "./reference-session";

describe("getReferenceSession", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    mocks.readGlobalExposureProfiles.mockReset();
    mocks.readBenchmarkPrices.mockReset();
    mocks.close.mockReset();
    mocks.createControlPlaneStore.mockClear();
    delete process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
    delete process.env.WORTHLINE_DB_AUTH_TOKEN;
  });

  test("defers control-plane close to after()", async () => {
    process.env.WORTHLINE_CONTROL_PLANE_DB_URL = "libsql://control-plane";
    mocks.readGlobalExposureProfiles.mockResolvedValue([]);

    await getReferenceSession();

    expect(mocks.createControlPlaneStore).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);

    afterCallbacks[0]!();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  test("closes the control plane in finally even when the catalog read throws", async () => {
    process.env.WORTHLINE_CONTROL_PLANE_DB_URL = "libsql://control-plane";
    mocks.readGlobalExposureProfiles.mockRejectedValue(new Error("boom"));

    const session = await createReferenceSessionForTarget(
      { kind: "local" },
      {
        openControlPlane: async () =>
          ({
            readGlobalExposureProfiles: mocks.readGlobalExposureProfiles,
            readBenchmarkPrices: mocks.readBenchmarkPrices,
            close: mocks.close,
          }) as unknown as ControlPlaneStore,
      },
    );
    await expect(session.exposureCatalogReader.readCatalog()).resolves.toEqual({
      status: "unavailable",
      reason: "read_failed",
    });

    session.close();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});

describe("createReferenceSessionForTarget", () => {
  beforeEach(() => {
    mocks.readGlobalExposureProfiles.mockReset();
    mocks.close.mockReset();
    mocks.createControlPlaneStore.mockClear();
    delete process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
    delete process.env.WORTHLINE_DB_AUTH_TOKEN;
  });

  test("local without control-plane URL returns not_configured", async () => {
    const session = await createReferenceSessionForTarget({ kind: "local" });

    await expect(session.exposureCatalogReader.readCatalog()).resolves.toEqual({
      status: "unavailable",
      reason: "not_configured",
    });
    expect(mocks.createControlPlaneStore).not.toHaveBeenCalled();
  });

  test("demo uses a read-only fixture without opening the control plane", async () => {
    const session = await createReferenceSessionForTarget({
      kind: "demo",
      persona: "joven",
      now: "",
    });

    await expect(session.exposureCatalogReader.readCatalog()).resolves.toEqual({
      status: "available",
      profiles: [],
    });
    expect(mocks.createControlPlaneStore).not.toHaveBeenCalled();
  });

  test("opens the control plane when the URL is configured", async () => {
    process.env.WORTHLINE_CONTROL_PLANE_DB_URL = "libsql://control-plane";
    process.env.WORTHLINE_DB_AUTH_TOKEN = "token";
    mocks.readGlobalExposureProfiles.mockResolvedValue([]);

    const session = await createReferenceSessionForTarget({ kind: "local" });

    await session.exposureCatalogReader.readCatalog();

    expect(mocks.createControlPlaneStore).toHaveBeenCalledWith({
      url: "libsql://control-plane",
      authToken: "token",
    });
  });
});
