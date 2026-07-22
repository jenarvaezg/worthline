import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  buildContentSecurityPolicy,
  CSP_HEADER_NAME,
  securityHeaders,
} from "./security-headers";

// next.config.ts lives one level up; the no-upward-import lint rule (#361)
// forbids importing it, so the wiring guard reads its source instead.
const nextConfigSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "next.config.ts"),
  "utf8",
);

function headerMap(dev: boolean): Map<string, string> {
  return new Map(securityHeaders({ dev }).map((h) => [h.key, h.value]));
}

describe("securityHeaders", () => {
  test("declares every hardening header (#1179)", () => {
    const headers = headerMap(false);

    const hsts = headers.get("Strict-Transport-Security");
    expect(hsts).toBeDefined();
    // max-age >= 2 years, with subdomains + preload.
    const maxAge = Number(/max-age=(\d+)/.exec(hsts ?? "")?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(63_072_000);
    expect(hsts).toContain("includeSubDomains");
    expect(hsts).toContain("preload");

    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");

    const permissions = headers.get("Permissions-Policy") ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
      expect(permissions).toContain(`${feature}=()`);
    }
  });

  test("ships the CSP report-only, never enforced yet", () => {
    const headers = headerMap(false);
    expect(headers.has(CSP_HEADER_NAME)).toBe(true);
    expect(CSP_HEADER_NAME).toBe("Content-Security-Policy-Report-Only");
    // Guard against accidentally enforcing before the observation window closes.
    expect(headers.has("Content-Security-Policy")).toBe(false);
  });
});

describe("buildContentSecurityPolicy", () => {
  test("locks down the security-critical directives", () => {
    const csp = buildContentSecurityPolicy({ dev: false });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  test("scopes img-src to self, data URIs and the two external CDNs", () => {
    const csp = buildContentSecurityPolicy({ dev: false });
    const imgSrc = csp
      .split(";")
      .find((d) => d.trim().startsWith("img-src"))
      ?.trim();
    expect(imgSrc).toBe(
      "img-src 'self' data: https://en.numista.com https://coin-images.coingecko.com",
    );
  });

  test("keeps connect-src same-origin", () => {
    const csp = buildContentSecurityPolicy({ dev: false });
    const connectSrc = csp
      .split(";")
      .find((d) => d.trim().startsWith("connect-src"))
      ?.trim();
    expect(connectSrc).toBe("connect-src 'self'");
  });

  test("adds 'unsafe-eval' to script-src only in dev (HMR), never in prod", () => {
    expect(buildContentSecurityPolicy({ dev: true })).toContain("'unsafe-eval'");
    expect(buildContentSecurityPolicy({ dev: false })).not.toContain("'unsafe-eval'");
  });
});

describe("next.config wiring", () => {
  test("hides the framework banner", () => {
    expect(nextConfigSource).toContain("poweredByHeader: false");
  });

  test("applies the security headers to every route", () => {
    expect(nextConfigSource).toContain("securityHeaders(");
    expect(nextConfigSource).toContain('source: "/:path*"');
  });
});
