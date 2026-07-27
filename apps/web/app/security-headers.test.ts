import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  buildContentSecurityPolicy,
  buildEnforcedContentSecurityPolicy,
  CSP_ENFORCED_HEADER_NAME,
  CSP_REPORT_ONLY_HEADER_NAME,
  ENFORCED_CSP_DIRECTIVES,
  securityHeaders,
} from "./security-headers";

/** The directives a policy declares, as `name → value` (order-independent). */
function directivesOf(policy: string): Map<string, string> {
  return new Map(
    policy.split(";").map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/);
      return [name ?? "", values.join(" ")];
    }),
  );
}

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

  test("ships both CSP headers: the enforced subset and the full report-only policy (#1256)", () => {
    const headers = headerMap(false);

    expect(CSP_ENFORCED_HEADER_NAME).toBe("Content-Security-Policy");
    expect(CSP_REPORT_ONLY_HEADER_NAME).toBe("Content-Security-Policy-Report-Only");
    expect(headers.get(CSP_ENFORCED_HEADER_NAME)).toBe(
      buildEnforcedContentSecurityPolicy({ dev: false }),
    );
    expect(headers.get(CSP_REPORT_ONLY_HEADER_NAME)).toBe(
      buildContentSecurityPolicy({ dev: false }),
    );
  });
});

describe("buildEnforcedContentSecurityPolicy (#1256)", () => {
  test("enforces the two egress directives and NOTHING else", () => {
    // Deliberately exact. Every other directive of the target policy can break a
    // real surface (`script-src`/`style-src` without a nonce, `form-action` on the
    // Google sign-in redirect), so promoting one is a decision with evidence
    // behind it, never a drive-by edit.
    expect([...ENFORCED_CSP_DIRECTIVES]).toEqual(["img-src", "connect-src"]);
    expect([
      ...directivesOf(buildEnforcedContentSecurityPolicy({ dev: false })).keys(),
    ]).toEqual(["img-src", "connect-src"]);
  });

  test("never carries default-src, which would enforce the whole policy by the back door", () => {
    // `default-src` is the fallback for script/style/font/frame/worker/manifest
    // fetches: shipping it in the ENFORCED header would block everything the
    // report-only header is still only observing.
    for (const dev of [false, true]) {
      expect(buildEnforcedContentSecurityPolicy({ dev })).not.toContain("default-src");
    }
  });

  test("copies each enforced directive verbatim from the target policy", () => {
    // One directive table, two headers. If the enforced copy could drift, the
    // report-only header would stop being the preview of what enforcing means.
    for (const dev of [false, true]) {
      const target = directivesOf(buildContentSecurityPolicy({ dev }));
      for (const [name, value] of directivesOf(
        buildEnforcedContentSecurityPolicy({ dev }),
      )) {
        expect(value).toBe(target.get(name));
      }
    }
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
