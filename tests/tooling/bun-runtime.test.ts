import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const webPackage = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../apps/web/package.json"),
    "utf8",
  ),
) as { scripts: Record<string, string> };

describe("@worthline/web Bun runtime scripts (#813)", () => {
  test("dev, build, and start run Next under bun --bun", () => {
    expect(webPackage.scripts.dev).toContain("bun --bun next dev");
    expect(webPackage.scripts.build).toContain("bun --bun next build");
    expect(webPackage.scripts.start).toContain("bun --bun next start");
  });
});
