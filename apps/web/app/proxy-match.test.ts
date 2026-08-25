import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { MACHINE_ENDPOINT_PREFIXES } from "./auth-gate";
import { PROXY_MATCHER, shouldInvokeProxy } from "./proxy-match";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const proxySource = readFileSync(join(appDirectory, "..", "proxy.ts"), "utf8");

/**
 * Next's matcher is a path-to-regexp pattern that, for this shape, is a JS
 * regex over the full pathname. Pinning both the decision function and the
 * string the proxy actually exports keeps them from drifting (#1536).
 */
function matcherHits(pathname: string): boolean {
  return new RegExp(`^${PROXY_MATCHER}$`).test(pathname);
}

const SKIP = [
  "/",
  "/login",
  "/demo",
  "/demo/persona",
  "/api/auth/signin",
  "/api/auth/callback/google",
  "/api/cron/snapshot",
  "/api/mcp",
  "/api/mcp/tools",
  "/.well-known/oauth-protected-resource",
  "/.well-known/openid-configuration",
  "/manifest.json",
  "/mcp-icon.svg",
  "/sw.js",
  "/favicon.ico",
  "/_next/static/chunks/app.js",
  "/_next/image",
  "/og.png",
  "/brand.svg",
] as const;

const RUN = ["/patrimonio", "/ajustes", "/historico", "/api/chat"] as const;

describe("shouldInvokeProxy (#1536)", () => {
  test("skips statics, well-known, cron, and public routes", () => {
    for (const pathname of SKIP) {
      expect(shouldInvokeProxy(pathname), pathname).toBe(false);
      expect(matcherHits(pathname), pathname).toBe(false);
    }
  });

  test("still runs on gated pages (demo persona cookie is checked here)", () => {
    for (const pathname of RUN) {
      expect(shouldInvokeProxy(pathname), pathname).toBe(true);
      expect(matcherHits(pathname), pathname).toBe(true);
    }
  });

  // The matcher is a hand-copied string (Next parses it statically), so every
  // machine endpoint has to be walked against it — a fourth one added to the
  // array but forgotten in the regex would still pay the lambda and the JWT.
  test("skips every machine endpoint, including the ones added later", () => {
    for (const prefix of MACHINE_ENDPOINT_PREFIXES) {
      for (const pathname of [prefix, `${prefix}/algo`]) {
        expect(shouldInvokeProxy(pathname), pathname).toBe(false);
        expect(matcherHits(pathname), pathname).toBe(false);
      }
    }
  });

  test("proxy.ts inlines the matcher (Next requires a static string) and skips Auth.js on public paths", () => {
    expect(proxySource).toContain(JSON.stringify(PROXY_MATCHER));
    expect(proxySource).toContain("shouldInvokeProxy");
    expect(proxySource).not.toMatch(/export default auth\(/);
  });
});
