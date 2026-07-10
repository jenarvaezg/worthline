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
  test("dev and start run Next under bun --bun", () => {
    expect(webPackage.scripts.dev).toContain("bun --bun next dev");
    expect(webPackage.scripts.start).toContain("bun --bun next start");
  });

  // The prebuilt Vercel deploy runs `next build`. Building the proxy
  // (apps/web/proxy.ts, Next 16 middleware) under `bun --bun` bundled it into a
  // Node serverless lambda whose CJS launcher require()s the emitted
  // `.next/server/middleware.js`; because apps/web/package.json is
  // `"type": "module"`, Node treats that file as ESM and require() throws
  // ERR_REQUIRE_ESM → MIDDLEWARE_INVOCATION_FAILED (500 on every route).
  // Keep the build on the Node runtime so the proxy stays on Edge.
  test("build runs Next under Node, not bun --bun", () => {
    expect(webPackage.scripts.build).toContain("next build");
    expect(webPackage.scripts.build).not.toContain("bun --bun next build");
  });
});
