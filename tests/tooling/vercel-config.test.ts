import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const vercelJson = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../apps/web/vercel.json"),
    "utf8",
  ),
) as { installCommand?: string };

describe("apps/web/vercel.json", () => {
  test("uses Bun for install (not npm — workspace:* deps)", () => {
    expect(vercelJson.installCommand).toMatch(/^bun install/);
  });
});
