import type { GlobalExposureProfile } from "@worthline/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createControlPlaneReferenceDataReaders,
  createFixedExposureCatalogReader,
  createUnavailableReferenceDataReaders,
} from "./reference-data-readers";

const sampleProfile: GlobalExposureProfile = {
  identity: { kind: "isin", isin: "IE00B3RBWM25" },
  displayName: "VWRL",
  breakdowns: { assetClass: { equity: "1" } },
  ter: "0.0022",
  trackedIndex: "FTSE All-World",
  hedgedToCurrency: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

describe("exposure catalog reader (#1011)", () => {
  test("returns injected available profiles", async () => {
    const reader = createFixedExposureCatalogReader({
      status: "available",
      profiles: [sampleProfile],
    });

    await expect(reader.readCatalog()).resolves.toEqual({
      status: "available",
      profiles: [sampleProfile],
    });
  });

  test("returns injected empty available catalog", async () => {
    const reader = createFixedExposureCatalogReader({
      status: "available",
      profiles: [],
    });

    await expect(reader.readCatalog()).resolves.toEqual({
      status: "available",
      profiles: [],
    });
  });

  test("returns injected not_configured without collapsing to an empty catalog", async () => {
    const reader =
      createUnavailableReferenceDataReaders("not_configured").exposureCatalogReader;

    await expect(reader.readCatalog()).resolves.toEqual({
      status: "unavailable",
      reason: "not_configured",
    });
  });

  test("anti-catch→[]: read_failed does not collapse to an empty catalog", async () => {
    const reader =
      createUnavailableReferenceDataReaders("read_failed").exposureCatalogReader;

    const availability = await reader.readCatalog();

    expect(availability).toEqual({
      status: "unavailable",
      reason: "read_failed",
    });
    expect(availability).not.toEqual({
      status: "available",
      profiles: [],
    });
  });
});

describe("control-plane exposure catalog reader (#1011)", () => {
  const readGlobalExposureProfiles = vi.fn();
  const readBenchmarkPrices = vi.fn();
  const close = vi.fn();

  beforeEach(() => {
    readGlobalExposureProfiles.mockReset();
    readBenchmarkPrices.mockReset();
    close.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("loads the catalog at most once per reader even when readCatalog is called multiple times", async () => {
    readGlobalExposureProfiles.mockResolvedValue([sampleProfile]);
    const readers = createControlPlaneReferenceDataReaders({
      readGlobalExposureProfiles,
      readBenchmarkPrices,
      close,
    } as never);

    const first = await readers.exposureCatalogReader.readCatalog();
    const second = await readers.exposureCatalogReader.readCatalog();

    expect(first).toEqual({ status: "available", profiles: [sampleProfile] });
    expect(second).toBe(first);
    expect(readGlobalExposureProfiles).toHaveBeenCalledTimes(1);
  });

  test("maps control-plane read failures to read_failed", async () => {
    readGlobalExposureProfiles.mockRejectedValue(new Error("transient"));
    const readers = createControlPlaneReferenceDataReaders({
      readGlobalExposureProfiles,
      readBenchmarkPrices,
      close,
    } as never);

    await expect(readers.exposureCatalogReader.readCatalog()).resolves.toEqual({
      status: "unavailable",
      reason: "read_failed",
    });
  });
});
