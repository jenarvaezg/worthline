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
 * The CSP ships as TWO headers (#1256, widened in #1273):
 *
 *  - `Content-Security-Policy` carries {@link ENFORCED_CSP_DIRECTIVES} — everything
 *    whose legitimate exceptions this repo can enumerate, which since #1273 is the
 *    whole target policy except the three the framework's inline output owns.
 *  - `Content-Security-Policy-Report-Only` carries the WHOLE target policy, so the
 *    rest keeps being observed instead of quietly disappearing. The overlap is
 *    deliberate: this header is the preview of what enforcing everything means,
 *    and it is what disappears the day the target policy is fully enforced.
 *
 * What stays observing is `script-src`, `style-src` and `default-src` (their
 * fallback), because Next's inline bootstrap and styled-jsx require
 * `'unsafe-inline'` and a nonce would cost this app its rendering model. That
 * decision — its price, and the condition that reopens it — is ADR 0068, not a
 * comment here.
 */

/** Two years, the floor for HSTS preload-list eligibility. */
const HSTS_MAX_AGE_SECONDS = 63_072_000;

/**
 * External image CDNs the app renders directly via `<img>` (ADR 0009).
 *
 * MEASURED, not read off the code (#1272). These are provider-supplied values stored
 * per row, and `snapshot_position_holdings.image_url` is frozen at capture, so a
 * provider that moves its CDN leaves the old host in old rows forever — and now that
 * `img-src` blocks, such a row would render a broken thumbnail. Nothing in the suite
 * can see that: the enumeration of the *code* cannot reach a host sitting in a row,
 * and no e2e journey loads a remote image. So the real workspace DBs were read
 * instead, with `.local/scripts/csp-image-hosts-audit.ts` (hostnames and counts only,
 * never a URL or a label):
 *
 *   2026-07-28 — 2 workspaces, 5233 stored values, 181 distinct URLs, TWO origins:
 *     https://en.numista.com              5191  (233 live + 4958 frozen)   HEAD 200
 *     https://coin-images.coingecko.com     42  (frozen only)              HEAD 200
 *
 * Both were already named below, so the allowlist needed no new entry — the audit's
 * result is that claim, which nothing had established before. Three findings worth
 * keeping:
 *
 *  - No `assets.coingecko.com`. The pre-migration host this gap was opened for
 *    survives in NO row, and both origins that do survive still SERVE (a `HEAD` on
 *    a real stored path per origin, since a hostname keeps looking fine long after
 *    it stops answering). So there is no dead CDN to decide about: nothing to
 *    backfill, and the glyph fallback never comes up. Should a `404` ever show up
 *    there, the frozen column is what gets backfilled — a dead host cannot be
 *    re-fetched, so the alternative is accepting the glyph for those rows.
 *  - `positions.image_url` (the live CoinGecko logo) is empty today, so all 42
 *    CoinGecko values live ONLY in frozen snapshots. That is exactly why the entry
 *    stays: `historico-table.tsx` still renders them from the frozen column, and no
 *    live sync would ever rewrite a row to a new host.
 *  - The audit itself had to grow to see this. It first read only the two
 *    `image_url` columns and missed `positions.obverse_thumb_url` — the LIVE Numista
 *    thumb, which the capture maps into `image_url` (`connected-source.ts`). Reading
 *    only the frozen side enumerates yesterday's hosts.
 *
 * Whatever a future re-run turns up gets NAMED here, never turned into a wildcard:
 * the point of the directive is that an allowed host is one we can name. What keeps
 * the audit honest between runs are the two guardians in `security-headers.test.ts`:
 * they pin the `<img>` call sites and the schema columns that can hold an image URL,
 * so a fourth of either fails the suite instead of silently outdating these numbers.
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
 * The origin the `/login` form submission redirects to (#1273).
 *
 * `auth.config.ts` declares one provider, Google, whose `issuer` is this origin, and
 * `signIn("google")` inside the login page's server action answers the POST with a
 * single 303 straight there. Named rather than inferred, because `form-action` is
 * the one directive whose allowlist is a *navigation destination*: get it wrong and
 * the app has no front door. The provider set is pinned in `security-headers.test.ts`
 * so a second OAuth provider (a second sign-in destination) fails the suite instead
 * of shipping a login that CSP blocks.
 */
const GOOGLE_ACCOUNTS_ORIGIN = "https://accounts.google.com";

/**
 * The directives that BLOCK, not just report (#1256, widened in #1273).
 *
 * The bar is the same for every entry: its legitimate exceptions are *enumerable
 * from this repo or measured*, never taken on faith. What each one rests on:
 *
 *  - `img-src` — the only remote images are {@link IMAGE_CDN_HOSTS}, rendered by
 *    three `<img>` call sites (a coin thumb, a token logo, the histórico row).
 *    Nothing builds `blob:`/`createObjectURL` image sources. Together with
 *    `connect-src` these are the two that stop data LEAVING the page: a remote
 *    `<img src>` and a `fetch()` are both outbound requests the browser makes with
 *    the user's data in the URL and no click required (the exfiltration channel
 *    #1246 closed at the render seam — this is the net under any later sink).
 *  - `connect-src` — no client-side dependency reaches a third party: no analytics,
 *    no Speed Insights, no browser-side Paddle (`@paddle/paddle-node-sdk` is
 *    server-only), no hardcoded cross-origin `fetch` in the app tree.
 *  - `font-src` — every face is local: `layout.tsx` is the only `next/font` caller
 *    and every `path:` it passes sits in `app/fonts/` (a self-hosted subset,
 *    `scripts/subset-web-fonts.sh`), so the browser fetches them from
 *    `/_next/static/media`. No CSS declares an `@font-face` of its own and no
 *    stylesheet references a remote `url(…)`.
 *  - `object-src` / `base-uri` — the app renders no `<object>`, `<embed>` or
 *    `<applet>`, and injects no `<base>`. Both are pinned by a guardian walk over
 *    the whole web tree, so the day one appears the suite says so.
 *  - `frame-ancestors` — a strict no-op in blast radius: `X-Frame-Options: DENY`
 *    below has been refusing every framer in every browser since #1179, so
 *    enforcing the modern spelling cannot break a frame that already loaded.
 *  - `form-action` — the measured one; see below.
 *
 * `form-action` was the trap #1273 was told to test rather than reason about, and
 * measuring it in Chromium changed the answer. `/login` is a `<form>` whose server
 * action answers with a 303 to {@link GOOGLE_ACCOUNTS_ORIGIN}, and the two paths
 * behave differently:
 *
 *   hydrated click → React submits the action as a `fetch` and the router performs
 *     the navigation. `form-action` never applies; nothing is reported.
 *   no-JS / pre-hydration click → a native form POST whose 303 the browser follows
 *     as part of the submission. `form-action` DOES apply, and the report-only
 *     header already logged it:
 *       «Sending form data to 'http://127.0.0.1:3009/login' violates the following
 *        report-only Content Security Policy directive: "form-action 'self'"»
 *
 * So `'self'` alone would have shut the front door for anyone clicking before
 * hydration (journey 49 exists because that window is real). Note the URL Chrome
 * names: the SAME-ORIGIN action, not the redirect target — it withholds the
 * destination to avoid leaking it, which reads like a browser bug when debugging.
 *
 * Naming the destination is what unblocks it, and the promotion was verified that
 * way round too: with `form-action 'self' https://accounts.google.com` ENFORCED, a
 * no-JS click on the real `/login` (auth wired up as in `playwright.routing.config.ts`)
 * lands on `accounts.google.com` with ZERO console errors — no violation, in either
 * disposition. What the allowance does NOT give away is measured by journey 47: a form
 * POST to any other host is still refused. Google's own further hops stay on the same
 * host, and the return leg is a GET to our callback, i.e. `'self'`.
 *
 * That measurement is not repeatable in CI: the main suite runs with `AUTH_GOOGLE_*`
 * blank (no sign-in button to click) and the routing config is not wired into the
 * workflow — and pointing a CI job at accounts.google.com would buy a flake. What
 * guards the claim between runs is the provider pin in `security-headers.test.ts`
 * plus journey 47 asserting the value reaches the browser.
 *
 * What observes all of this. #1256 recorded that a report-only violation is
 * invisible to the suite; that is MEASURED FALSE (#1273). Chrome logs report-only
 * violations through `console.error` with the wording above, and `e2e/fixtures.ts`
 * fails any journey that reports a console error — so the main suite has been
 * failing on report-only violations all along, and a green suite is evidence that
 * the WHOLE target policy is clean across everything the journeys touch. That is
 * the observation channel this app was thought not to have, which is why no
 * `report-uri`/`report-to` endpoint is being built (ADR 0068).
 *
 * It still only observes what the journeys exercise: `connect-src` is covered by
 * every page they load, while `img-src` is NOT, because no journey loads a remote
 * image (the demo personas seed `imageUrl: null` and the fake CoinGecko serves no
 * logos). A stale host sitting in a row of real data is closed by MEASUREMENT
 * instead — see {@link IMAGE_CDN_HOSTS} for what #1272 found.
 *
 * `default-src` must NEVER be added here: it is the fallback for script, style,
 * frame, worker and manifest fetches, so enforcing it would enforce `script-src`
 * and `style-src` through the back door.
 *
 * Declared in the same order as the directive table, so the serialized enforced
 * header reads in this order too.
 */
export const ENFORCED_CSP_DIRECTIVES = [
  "img-src",
  "font-src",
  "connect-src",
  "object-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
] as const;

const ENFORCED_CSP_DIRECTIVE_SET: ReadonlySet<string> = new Set(ENFORCED_CSP_DIRECTIVES);

/** One directive of the policy: its name and the source list it allows. */
type CspDirective = [name: string, values: string[]];

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
function contentSecurityPolicyDirectives({ dev }: { dev: boolean }): CspDirective[] {
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
    // All form posts are same-origin server actions (PRD #1112) — except the
    // sign-in, whose 303 the browser follows as part of the submission (#1273).
    ["form-action", ["'self'", GOOGLE_ACCOUNTS_ORIGIN]],
    // Anti-clickjacking, the modern counterpart to X-Frame-Options: DENY.
    ["frame-ancestors", ["'none'"]],
  ];
}

function serializeDirectives(directives: CspDirective[]): string {
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/** The full target policy, for the report-only header. */
export function buildContentSecurityPolicy({ dev }: { dev: boolean }): string {
  return serializeDirectives(contentSecurityPolicyDirectives({ dev }));
}

/** The blocking subset: {@link ENFORCED_CSP_DIRECTIVES}, verbatim from the table. */
export function buildEnforcedContentSecurityPolicy({ dev }: { dev: boolean }): string {
  return serializeDirectives(
    contentSecurityPolicyDirectives({ dev }).filter(([name]) =>
      ENFORCED_CSP_DIRECTIVE_SET.has(name),
    ),
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
