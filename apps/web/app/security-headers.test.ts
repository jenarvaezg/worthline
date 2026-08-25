import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** Everything the enforced header blocks, in serialization order (#1256, #1273). */
const ENFORCED_DIRECTIVE_ORDER = [
  "img-src",
  "font-src",
  "connect-src",
  "object-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
] as const;

describe("buildEnforcedContentSecurityPolicy (#1256, #1273)", () => {
  test("enforces the audited directives and NOTHING else", () => {
    // Deliberately exact. What is missing is the point: `script-src` and
    // `style-src` need `'unsafe-inline'` for Next's inline bootstrap and
    // styled-jsx, and `default-src` is their fallback (ADR 0068). Promoting one
    // is a decision with evidence behind it, never a drive-by edit.
    expect([...ENFORCED_CSP_DIRECTIVES]).toEqual([...ENFORCED_DIRECTIVE_ORDER]);
    expect([
      ...directivesOf(buildEnforcedContentSecurityPolicy({ dev: false })).keys(),
    ]).toEqual([...ENFORCED_DIRECTIVE_ORDER]);
  });

  test("leaves the framework's inline output observing, never blocking", () => {
    const enforced = directivesOf(buildEnforcedContentSecurityPolicy({ dev: false }));
    for (const observed of ["script-src", "style-src", "default-src"]) {
      expect(enforced.has(observed)).toBe(false);
    }
    // …and the report-only header keeps previewing all three.
    const preview = directivesOf(buildContentSecurityPolicy({ dev: false }));
    for (const observed of ["script-src", "style-src", "default-src"]) {
      expect(preview.has(observed)).toBe(true);
    }
  });

  test("never carries default-src, which would enforce the whole policy by the back door", () => {
    // `default-src` is the fallback for script/style/frame/worker/manifest
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
  });

  test("form-action allows the sign-in destination and nothing else (#1273)", () => {
    // MEASURED, not reasoned: a no-JS click on /login is a native POST whose 303 to
    // accounts.google.com the browser follows as part of the submission, so
    // `form-action 'self'` alone blocked the app's front door. Naming the one
    // destination keeps every OTHER cross-origin form POST refused.
    expect(
      directivesOf(buildContentSecurityPolicy({ dev: false })).get("form-action"),
    ).toBe("'self' https://accounts.google.com");
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

/**
 * The evidence behind the directives #1273 promoted.
 *
 * Each of these four was verified by READING the code, the way #1256 verified the two
 * egress ones. A test is what keeps that reading true: the claim «the app renders no
 * `<object>`» is only worth a blocking directive for as long as nobody adds one, and
 * the failure mode of a stale claim here is a surface that silently stops working in
 * production while every test stays green.
 */
const FONT_LOADER_MODULE = "app/layout.tsx";

/** Every `<object>`/`<embed>`/`<applet>`/`<base>` in `source` that is an ELEMENT. */
function pluginElementCount(source: string): number {
  // `[^\w$]` before the `<` is what separates JSX from a generic type argument:
  // `WeakSet<object>` has an identifier character there, `  <object data=…>` does
  // not. Without it the guardian would fire on `walk-deep.ts` forever and get
  // deleted for crying wolf.
  return (
    stripComments(source).match(/(^|[^\w$])<(object|embed|applet|base)\b/g)?.length ?? 0
  );
}

/** Every `.css` under `root`, skipping build output — the TS walk cannot see these. */
function walkStylesheets(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      files.push(...walkStylesheets(fullPath));
      continue;
    }
    if (entry.name.endsWith(".css")) files.push(fullPath);
  }
  return files;
}

describe("the promoted directives' evidence (#1273)", () => {
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

  test("object-src/base-uri: the app renders no plugin element and no <base>", () => {
    const offenders = readSourceFiles(webRoot)
      .filter(({ source }) => pluginElementCount(source) > 0)
      .map(({ filePath }) => filePath.slice(webRoot.length + 1));

    expect(
      offenders,
      "`object-src 'none'` and `base-uri 'self'` BLOCK now — an <object>/<embed> " +
        "will not load and a <base> will be ignored. Decide the directive before " +
        "shipping the element, not after the surface breaks in production",
    ).toEqual([]);
  });

  test("font-src: every face is loaded from the app's own bundle", () => {
    const fontImporters = readSourceFiles(webRoot)
      .filter(({ source }) => stripComments(source).includes("next/font"))
      .map(({ filePath }) => filePath.slice(webRoot.length + 1));
    expect(
      fontImporters,
      "a second next/font call site means the font-src evidence covers only half " +
        "the faces — `next/font/google` in particular self-hosts at build time, but " +
        "verify it rather than assume it",
    ).toEqual([FONT_LOADER_MODULE]);

    const layout = readFileSync(join(webRoot, FONT_LOADER_MODULE), "utf8");
    expect(layout).toContain('from "next/font/local"');
    const paths = [...layout.matchAll(/path:\s*"([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith("./fonts/"), `${path} is not a local font file`).toBe(true);
      // Named, not globbed: a path that no longer resolves is a face the browser
      // would fetch from somewhere else.
      expect(existsSync(join(webRoot, "app", path.slice(2)))).toBe(true);
    }
  });

  test("font-src: no stylesheet declares a face of its own", () => {
    // This is the WHOLE of the CSS side of the evidence: a font can only be fetched
    // through an `@font-face`, so with none hand-written, the next/font reading above
    // enumerates every face the browser asks for. A new one is not forbidden — its
    // `src` just stops being covered, and `font-src 'self'` BLOCKS now.
    for (const filePath of walkStylesheets(join(webRoot, "app"))) {
      expect(
        readFileSync(filePath, "utf8"),
        `${filePath.slice(webRoot.length + 1)} declares an @font-face the font-src audit never read`,
      ).not.toContain("@font-face");
    }
  });

  test("no stylesheet fetches from an off-origin host", () => {
    // Not a font check — a `url()` in CSS is an IMAGE or a mask, and `img-src` has
    // been blocking since #1256. `data:` is deliberately allowed: the paper-grain
    // texture in globals.css is an inline SVG background, which is exactly why the
    // `data:` token is in the img-src allowlist and asserted above.
    for (const filePath of walkStylesheets(join(webRoot, "app"))) {
      const css = readFileSync(filePath, "utf8");
      expect(
        [...css.matchAll(/url\(\s*['"]?((?:https?:)?\/\/[^)'"]+)/g)].map((m) => m[1]),
        `${filePath.slice(webRoot.length + 1)} reaches an absolute host — img-src blocks any origin outside IMAGE_CDN_HOSTS`,
      ).toEqual([]);
    }
  });

  test("form-action: Google is the only sign-in destination configured", () => {
    // The allowlist is a NAVIGATION destination (accounts.google.com). A second
    // provider is a second destination, and the failure of forgetting it is that
    // nobody can sign in — so the provider set is pinned, not trusted to a comment.
    const authConfig = stripComments(
      readFileSync(join(webRoot, "app/auth.config.ts"), "utf8"),
    );
    expect(
      [...authConfig.matchAll(/from "next-auth\/providers\/([\w-]+)"/g)].map((m) => m[1]),
    ).toEqual(["google"]);
    expect(/providers:\s*\[Google\]/.test(authConfig)).toBe(true);
  });

  describe("the plugin-element scan itself", () => {
    test("counts a real element", () => {
      expect(pluginElementCount(`<object data="/a.pdf" />`)).toBe(1);
      expect(pluginElementCount(`<embed src="a" />\n<base href="/" />`)).toBe(2);
    });

    test("ignores a generic type argument and prose", () => {
      expect(pluginElementCount(`seen: WeakSet<object>,`)).toBe(0);
      expect(pluginElementCount(`const m = new Map<object, string>();`)).toBe(0);
      expect(pluginElementCount(`/** No <object> or <embed> anywhere. */`)).toBe(0);
    });
  });
});

describe("next.config wiring", () => {
  test("hides the framework banner", () => {
    expect(nextConfigSource).toContain("poweredByHeader: false");
  });

  test("applies the security headers to every route, and the widened one to the checkout route only (#1221)", () => {
    expect(nextConfigSource).toContain("securityHeaders(");
    // Everything except the checkout route gets the closed policy...
    expect(nextConfigSource).toContain('source: "/((?!premium/pagar).*)"');
    // ...and the checkout route its own entry. The two sources must not
    // overlap: a path matched by both gets two CSP headers, which the browser
    // intersects — and that intersection blocks the checkout it just widened.
    expect(nextConfigSource).toContain('source: "/premium/pagar"');
    expect(nextConfigSource).toContain("paddle: true");
  });
});

describe("the checkout route's widened policy (#1221)", () => {
  const closed = directivesOf(buildContentSecurityPolicy({ dev: false }));
  const widened = directivesOf(buildContentSecurityPolicy({ dev: false, paddle: true }));

  test("only the checkout route reaches Paddle — the default policy names it nowhere", () => {
    for (const [, values] of closed) {
      expect(values).not.toContain("paddle.com");
    }
    expect(
      new Map(securityHeaders({ dev: false }).map((h) => [h.key, h.value])).get(
        "Permissions-Policy",
      ),
    ).toContain("payment=()");
  });

  test("widens exactly the four directives the checkout needs, and nothing else", () => {
    const changed = [...widened.entries()]
      .filter(([name, values]) => closed.get(name) !== values)
      .map(([name]) => name);

    // `style-src` is in this list because Paddle.js links a stylesheet from its
    // CDN into OUR document — undocumented, found as a `style-src-elem` report
    // the first time a real checkout opened under this policy (#1221).
    expect(changed.sort()).toEqual([
      "connect-src",
      "frame-src",
      "script-src",
      "style-src",
    ]);
    // The payment form is an iframe, so a widened `frame-src` is the whole
    // point; the closed policy has no such directive at all.
    expect(closed.has("frame-src")).toBe(false);
  });

  test("names both the sandbox and the production hosts (one build serves both)", () => {
    expect(widened.get("script-src")).toContain("https://cdn.paddle.com");
    expect(widened.get("script-src")).toContain("https://sandbox-cdn.paddle.com");
    expect(widened.get("frame-src")).toContain("https://buy.paddle.com");
    expect(widened.get("frame-src")).toContain("https://sandbox-buy.paddle.com");
    expect(widened.get("connect-src")).toContain("https://checkout-service.paddle.com");
    expect(widened.get("connect-src")).toContain(
      "https://sandbox-checkout-service.paddle.com",
    );
    expect(widened.get("style-src")).toContain("https://cdn.paddle.com");
    expect(widened.get("style-src")).toContain("https://sandbox-cdn.paddle.com");
  });

  test("keeps `self` in every widened directive — Paddle is added, never substituted", () => {
    for (const name of ["script-src", "connect-src", "style-src"]) {
      expect(widened.get(name)).toContain("'self'");
    }
    expect(widened.get("style-src")).toContain("'unsafe-inline'");
  });

  test("`connect-src` keeps BLOCKING on the checkout route (#1256)", () => {
    // The widening must not quietly demote the directive that stops data
    // leaving the page: it is still in the enforced header, just with Paddle in
    // its allowlist.
    const enforced = directivesOf(
      buildEnforcedContentSecurityPolicy({ dev: false, paddle: true }),
    );
    expect(enforced.get("connect-src")).toContain(
      "https://sandbox-checkout-service.paddle.com",
    );
    expect(enforced.get("connect-src")).toContain("'self'");
    expect(enforced.get("img-src")).toBeDefined();
  });

  test("wallets are allowed inside Paddle's frame, and only there", () => {
    const permissions = new Map(
      securityHeaders({ dev: false, paddle: true }).map((h) => [h.key, h.value]),
    ).get("Permissions-Policy");

    expect(permissions).toContain('payment=(self "https://buy.paddle.com"');
    expect(permissions).toContain('"https://sandbox-buy.paddle.com"');
    // The rest of the hardening is untouched.
    for (const feature of ["camera", "microphone", "geolocation", "usb"]) {
      expect(permissions).toContain(`${feature}=()`);
    }
  });
});
