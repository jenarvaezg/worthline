import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const nextConfig = readFileSync(join(appDirectory, "..", "next.config.ts"), "utf8");
const instrumentation = readFileSync(
  join(appDirectory, "..", "instrumentation.ts"),
  "utf8",
);

/**
 * Cold-start cost (#1536): sharp/libvips is 18 MB of a 41 MB page lambda for an
 * image runtime Vercel already provides, and the first request of each isolate
 * used to pay the require of `@libsql/client`, `drizzle-orm/libsql` and `big.js`.
 */
describe("lambda cold-start knobs (#1536)", () => {
  test("page-function tracing excludes sharp and @img/libvips", () => {
    expect(nextConfig).toMatch(/outputFileTracingExcludes/);
    expect(nextConfig).toMatch(/@img\//);
    expect(nextConfig).toMatch(/\bsharp\b/);
  });

  test("instrumentation register() preheats libsql, drizzle and big.js", () => {
    expect(instrumentation).toMatch(/preheatLibsqlStack/);
    expect(instrumentation).toMatch(/big\.js/);
  });
});
