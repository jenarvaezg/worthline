import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const nextConfig = readFileSync(join(appDirectory, "..", "next.config.ts"), "utf8");

/**
 * The Router Cache stays restored (#1531).
 *
 * #1229 retired `experimental.staleTimes.dynamic` on the premise that
 * `cacheComponents` had taken over the caching contract. The premise was
 * false: Cache Components is opt-in via `"use cache"` and the repo ships zero
 * directives, so nothing replaced the Client Cache — every tab click
 * re-rendered the whole tree server-side (0.6–3.3 s to real data in
 * production, even revisiting the same tab seconds later).
 *
 * This assertion is the tripwire: removing the knob again must come with a
 * deliberate replacement (per-route `"use cache"` + `cacheLife`), not silence.
 */
describe("Router Cache knob (#1531)", () => {
  test("next.config keeps a 30s dynamic client-cache TTL", () => {
    expect(nextConfig).toMatch(/staleTimes\s*:\s*{[^}]*\bdynamic\s*:\s*30(?![0-9])/);
  });
});
