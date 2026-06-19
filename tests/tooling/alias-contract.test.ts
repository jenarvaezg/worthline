import { describe, expect, it } from "vitest";

// Zone-alias contract tracer (#355). Each import below crosses the alias
// boundary defined in tsconfig.base.json / vitest.config.ts / tsconfig.e2e.json.
// If any alias stops resolving, the corresponding import throws at module load
// and the suite fails — making this file the empirical guard for the contract.
import { fd } from "@tests/helpers";
import { metalValueMinor } from "@pricing/metal";
import { money } from "@domain/money";
import { SCHEMA_VERSION } from "@db/migrate";
import { loadDashboard } from "@web/load-dashboard";

describe("zone alias contract (#355)", () => {
  it("resolves @domain/* to packages/domain/src", () => {
    expect(typeof money).toBe("function");
  });

  it("resolves @pricing/* to packages/pricing/src", () => {
    expect(typeof metalValueMinor).toBe("function");
  });

  it("resolves @db/* to packages/db/src", () => {
    expect(typeof SCHEMA_VERSION).toBe("number");
  });

  it("resolves @web/* to apps/web/app", () => {
    expect(typeof loadDashboard).toBe("function");
  });

  it("resolves @tests/* to tests", () => {
    expect(typeof fd).toBe("function");
  });
});
