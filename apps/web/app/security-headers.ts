/**
 * HTTP security headers applied to every response (#1179).
 *
 * Vercel does not inject these for you: `*.vercel.app` ships HSTS-preloaded, but
 * that coverage vanishes under a custom domain, and there is never a CSP nor an
 * anti-clickjacking header unless the app sets one. This module is the single
 * source of truth for that header set; `next.config.ts` returns it from
 * `headers()` over `/:path*`.
 *
 * Kept dependency-free (pure string building) so `next.config.ts` can import it
 * from the plain Node context in which the config is evaluated, and so the
 * policy can be unit-tested without a running server.
 *
 * The CSP ships as TWO headers (#1256):
 *
 *  - `Content-Security-Policy` carries {@link ENFORCED_CSP_DIRECTIVES} — the two
 *    that actually block data leaving the page, and the two whose legitimate
 *    exceptions are enumerable from this repo.
 *  - `Content-Security-Policy-Report-Only` carries the WHOLE target policy, so the
 *    rest keeps being observed instead of quietly disappearing. The overlap is
 *    deliberate: this header is the preview of what enforcing everything means,
 *    and it is what disappears the day the target policy is fully enforced.
 *
 * Why not all of it at once. `script-src` is the expensive one: this app has no
 * `middleware.ts` (by design — #1179), so we cannot mint a per-request nonce, and
 * Next's inline bootstrap/hydration scripts plus styled-jsx therefore need
 * `'unsafe-inline'`, which is most of what enforcing would have bought. And
 * `form-action 'self'` is not the freebie it looks like: `/login` is a `<form>`
 * whose server action redirects to accounts.google.com, and Chrome has long
 * applied `form-action` to a form submission's redirect target — so promoting it
 * means testing the Google sign-in in Chrome first, not reading the directive list.
 */

/** Two years, the floor for HSTS preload-list eligibility. */
const HSTS_MAX_AGE_SECONDS = 63_072_000;

/**
 * External image CDNs the app renders directly via `<img>` (ADR 0009).
 *
 * OPEN GAP, declared rather than closed: these are provider-supplied values stored
 * per row, not URLs this repo builds, and `snapshot_position_holdings.image_url` is
 * frozen at capture — so a provider that moves its CDN leaves the old host in old
 * rows forever, and now that `img-src` blocks, such a row renders a broken
 * thumbnail. No test can see it: the enumeration above reads the code, and no e2e
 * journey loads a remote image. What closes it is reading the data — the distinct
 * origins in `positions.image_url` and `snapshot_position_holdings.image_url` across
 * the real workspace DBs. Whatever that turns up gets NAMED here, never turned into
 * a wildcard: the point of the directive is that an allowed host is one we can name.
 *
 * Numista's thumbnails live on `en.numista.com` regardless of the `lang=es` the
 * client requests (verified in `packages/pricing/src/__fixtures__/numista`), so only
 * the CoinGecko entry is exposed to that drift.
 */
const IMAGE_CDN_HOSTS = [
  // Numista coin-catalogue thumbnails.
  "https://en.numista.com",
  // CoinGecko token logos.
  "https://coin-images.coingecko.com",
] as const;

/** Blocks violations of {@link ENFORCED_CSP_DIRECTIVES}. */
export const CSP_ENFORCED_HEADER_NAME = "Content-Security-Policy";

/** Observes the whole target policy without blocking any of it. */
export const CSP_REPORT_ONLY_HEADER_NAME = "Content-Security-Policy-Report-Only";

/**
 * The directives that BLOCK, not just report (#1256).
 *
 * These two are the ones that stop data leaving the page: a remote `<img src>` and
 * a `fetch()` are both outbound requests the browser makes with the user's data in
 * the URL and no click required (the exfiltration channel #1246 closed at the
 * render seam — this is the net under any other sink that appears later).
 *
 * They are also the two whose legitimate exceptions are *enumerable from this
 * repo* rather than from violation reports, which matters because nothing collects
 * the reports: the policy declares no `report-uri`/`report-to`, so «observed
 * clean» was never something this app could observe. What replaces the reports:
 *
 *  - `img-src`: the only remote images are {@link IMAGE_CDN_HOSTS}, rendered by
 *    three `<img>` call sites (a coin thumb, a token logo, the histórico row).
 *    Nothing builds `blob:`/`createObjectURL` image sources.
 *  - `connect-src`: no client-side dependency reaches a third party — no analytics,
 *    no Speed Insights, no browser-side Paddle (`@paddle/paddle-node-sdk` is
 *    server-only), and no hardcoded cross-origin `fetch` in the app tree.
 *
 * What keeps it true, and what does not. A blocked request logs a console error and
 * `e2e/fixtures.ts` fails any journey that reports one, so the journeys built on that
 * fixture are the observation window — executable in CI, unlike a report endpoint
 * nobody reads. But it only observes what the journeys exercise: `connect-src` is
 * covered by every page they load, while `img-src` is NOT, because no journey ever
 * loads a remote image (the demo personas seed `imageUrl: null` and the fake
 * CoinGecko serves no logos). So the suite catches a cross-origin URL newly
 * hardcoded in the app; it cannot catch a stale host sitting in a row of real data.
 * Only reading the data closes that one — see {@link IMAGE_CDN_HOSTS}.
 *
 * `default-src` must NEVER be added here: it is the fallback for script, style,
 * font, frame, worker and manifest fetches, so enforcing it would enforce the
 * entire policy through the back door.
 */
export const ENFORCED_CSP_DIRECTIVES = ["img-src", "connect-src"] as const;

/**
 * The target policy as an ordered directive table — the one source both headers
 * are serialized from, so the enforced subset cannot drift from what report-only
 * has been previewing.
 *
 * @param dev - When true (i.e. `next dev`), `'unsafe-eval'` is added to
 *   `script-src` for HMR/turbopack, which the production bundle does not need.
 *   Both headers are built from this same table, so a dev-only relaxation can
 *   never leak into what the deployed policy enforces.
 */
function contentSecurityPolicyDirectives({
  dev,
}: {
  dev: boolean;
}): Array<[string, string[]]> {
  const scriptSrc = ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])];
  return [
    ["default-src", ["'self'"]],
    ["script-src", scriptSrc],
    // styled-jsx, inline style attributes and the View Transitions API all emit
    // inline styles (ADR 0036).
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", ...IMAGE_CDN_HOSTS]],
    ["font-src", ["'self'"]],
    // Chat streaming (`useChat`) and the auth session probe are same-origin.
    ["connect-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    // All form posts are same-origin server actions (PRD #1112).
    ["form-action", ["'self'"]],
    // Anti-clickjacking, the modern counterpart to X-Frame-Options: DENY.
    ["frame-ancestors", ["'none'"]],
  ];
}

function serializeDirectives(directives: Array<[string, string[]]>): string {
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/** The full target policy, for the report-only header. */
export function buildContentSecurityPolicy({ dev }: { dev: boolean }): string {
  return serializeDirectives(contentSecurityPolicyDirectives({ dev }));
}

const ENFORCED: ReadonlySet<string> = new Set(ENFORCED_CSP_DIRECTIVES);

/** The blocking subset: {@link ENFORCED_CSP_DIRECTIVES}, verbatim from the table. */
export function buildEnforcedContentSecurityPolicy({ dev }: { dev: boolean }): string {
  return serializeDirectives(
    contentSecurityPolicyDirectives({ dev }).filter(([name]) => ENFORCED.has(name)),
  );
}

/**
 * The full ordered list of security headers for `next.config.ts` `headers()`.
 */
export function securityHeaders({
  dev,
}: {
  dev: boolean;
}): Array<{ key: string; value: string }> {
  return [
    {
      key: "Strict-Transport-Security",
      value: `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains; preload`,
    },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    },
    {
      key: CSP_ENFORCED_HEADER_NAME,
      value: buildEnforcedContentSecurityPolicy({ dev }),
    },
    { key: CSP_REPORT_ONLY_HEADER_NAME, value: buildContentSecurityPolicy({ dev }) },
  ];
}
