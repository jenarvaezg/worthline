import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const pricingSrc = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(pricingSrc, "../../..");

describe("connected-source lifecycle ADR 0043", () => {
  test("does not publish the old adapter lifecycle seam", () => {
    expect(existsSync(join(pricingSrc, "adapters/types.ts"))).toBe(false);
    expect(existsSync(join(pricingSrc, "adapters/registry.ts"))).toBe(false);
    expect(
      existsSync(join(repoRoot, "apps/web/app/ajustes/connected-source-lifecycle.ts")),
    ).toBe(false);

    const pricingIndex = readFileSync(join(pricingSrc, "index.ts"), "utf8");
    expect(pricingIndex).not.toContain("ConnectedSourceAdapter");
    expect(pricingIndex).not.toContain("adapterForTag");
  });
});
