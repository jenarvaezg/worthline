import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { readSourceFiles, stripComments } from "./guardian-walk";
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
    expect(directivesOf(buildContentSecurityPolicy({ dev: false })).get("img-src")).toBe(
      "'self' data: https://en.numista.com https://coin-images.coingecko.com",
    );
  });

  test("keeps connect-src same-origin", () => {
    expect(
      directivesOf(buildContentSecurityPolicy({ dev: false })).get("connect-src"),
    ).toBe("'self'");
  });

  test("adds 'unsafe-eval' to script-src only in dev (HMR), never in prod", () => {
    expect(buildContentSecurityPolicy({ dev: true })).toContain("'unsafe-eval'");
    expect(buildContentSecurityPolicy({ dev: false })).not.toContain("'unsafe-eval'");
  });
});

/**
 * The audited surface of #1272 — what a test CAN pin about `IMAGE_CDN_HOSTS`.
 *
 * The allowlist itself is NOT derivable from the code: the values are
 * provider-supplied and stored per row, so only reading the real data enumerates
 * them (`.local/scripts/csp-image-hosts-audit.ts`). What the code DOES decide is the
 * SURFACE that audit has to cover — which `<img>` tags exist, and which columns can
 * reach one. A fourth of either means the enumeration is stale and the audit has to
 * run again, so both are pinned here.
 */
const REMOTE_IMAGE_RENDER_SITES = [
  "app/(workspace)/historico/historico-table.tsx",
  "app/(workspace)/patrimonio/[id]/editar/_surfaces/binance-holding-section.tsx",
  "app/(workspace)/patrimonio/[id]/editar/_surfaces/coin-collection-section.tsx",
] as const;

/** Table → the columns holding a URL, as the audit reads them. */
const AUDITED_IMAGE_COLUMNS = [
  ["positions", ["obverse_thumb_url", "image_url"]],
  ["snapshotPositionHoldings", ["image_url"]],
] as const;

/** Every `<img` in `source` that is code rather than prose. */
function imgTagCount(source: string): number {
  return stripComments(source).split("<img").length - 1;
}

describe("stored image hosts (#1272)", () => {
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

  test("renders <img> from exactly the audited call sites", () => {
    // The whole app, not just `app/`: an `<img>` added beside it would otherwise slip
    // past a guardian that only looked at the routes. Comments are stripped by the
    // shared walk, so PROSE about the tag never counts as a call site —
    // `assistant-markdown.tsx` documents stripping remote images, the exact opposite
    // of rendering one.
    const sites = readSourceFiles(webRoot)
      .filter(({ source }) => imgTagCount(source) > 0)
      .map(({ filePath }) => filePath.slice(webRoot.length + 1))
      .sort();

    // Deliberately ALL `<img>`, not just the ones with a remote `src`: a local-asset
    // tag tripping this is the cheap failure (read it, add it), while narrowing the
    // match to something that looks provider-supplied is how the stored-host case
    // goes silent. `next/image` is unused in this app; were a stored URL ever routed
    // through it, this guardian would not see it and the audit note would go stale.
    expect(
      sites,
      "a new <img> means a stored, provider-supplied host may now reach the browser " +
        "through a surface the #1272 audit never enumerated — re-run " +
        "`.local/scripts/csp-image-hosts-audit.ts` and update IMAGE_CDN_HOSTS",
    ).toEqual([...REMOTE_IMAGE_RENDER_SITES].sort());
  });

  test("audits every schema column that can hold an image URL", () => {
    // The audit's own first version read only the two `image_url` columns and missed
    // `positions.obverse_thumb_url`, the LIVE Numista thumb — so the column list is
    // pinned against the schema, not trusted to a comment.
    const schema = stripComments(
      readFileSync(join(webRoot, "..", "..", "packages/db/src/schema.ts"), "utf8"),
    );

    for (const [table, expectedColumns] of AUDITED_IMAGE_COLUMNS) {
      const start = schema.indexOf(`export const ${table} = sqliteTable(`);
      expect(start, `${table} not found in schema.ts`).toBeGreaterThan(-1);
      const nextExport = schema.indexOf("\nexport ", start + 1);
      const body = schema.slice(start, nextExport === -1 ? undefined : nextExport);

      const urlColumns = [...body.matchAll(/text\("([a-z_]*url[a-z_]*)"\)/g)].map(
        (match) => match[1],
      );
      expect(
        urlColumns.sort(),
        `${table} gained or lost a URL column — the #1272 audit enumerates ` +
          "hostnames per column, so its script has to cover this one too",
      ).toEqual([...expectedColumns].sort());
    }
  });

  describe("the scan itself", () => {
    test("counts a real tag", () => {
      expect(imgTagCount(`<img alt="" src={p.imageUrl} />`)).toBe(1);
      expect(imgTagCount(`<img src="a" />\n<img src="b" />`)).toBe(2);
    });

    test("ignores images named in prose", () => {
      expect(imgTagCount(`/** A remote \`<img src>\` is an outbound GET. */`)).toBe(0);
      expect(imgTagCount(`// biome-ignore: external <img> thumb\nconst a = 1;`)).toBe(0);
    });
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
