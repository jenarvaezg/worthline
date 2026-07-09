import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const renovate = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../renovate.json"),
    "utf8",
  ),
) as {
  extends: string[];
  packageRules: Array<{
    groupName?: string;
    automerge?: boolean;
    allowedVersions?: string;
  }>;
};

describe("renovate.json", () => {
  test("uses recommended preset and profile B rules from #810", () => {
    expect(renovate.extends).toContain("config:recommended");
    expect(renovate.packageRules.some((r) => r.groupName === "next-react")).toBe(true);
    expect(renovate.packageRules.some((r) => r.automerge === true)).toBe(true);
    expect(renovate.packageRules.some((r) => r.allowedVersions === "<7")).toBe(true);
  });
});
