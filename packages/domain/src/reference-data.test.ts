import { describe, expect, test } from "vitest";

import type {
  BenchmarkSeriesAvailability,
  ExposureCatalogAvailability,
} from "./reference-data";

describe("reference data availability (#943)", () => {
  test("available catalog with profiles is distinct from unavailable read_failed", () => {
    const available: ExposureCatalogAvailability = {
      status: "available",
      profiles: [],
    };
    const failed: ExposureCatalogAvailability = {
      status: "unavailable",
      reason: "read_failed",
    };

    expect(available.status).toBe("available");
    expect(failed.status).toBe("unavailable");
    expect(failed.reason).toBe("read_failed");
  });

  test("benchmark series mirrors the same unavailable reasons", () => {
    const notConfigured: BenchmarkSeriesAvailability = {
      status: "unavailable",
      reason: "not_configured",
    };

    expect(notConfigured.reason).toBe("not_configured");
  });
});
