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
 * The CSP ships first as `Content-Security-Policy-Report-Only` (see
 * {@link CSP_HEADER_NAME}): browsers report violations without blocking, so we
 * can observe real breakage before flipping to enforce. Notably, this app has
 * no `middleware.ts` (by design — #1179), so we cannot mint a per-request nonce;
 * Next's inline bootstrap/hydration scripts and styled-jsx therefore require
 * `'unsafe-inline'`. Replacing that with nonces is the enforce-time hardening
 * step and is deliberately out of scope here.
 */

/** Two years, the floor for HSTS preload-list eligibility. */
const HSTS_MAX_AGE_SECONDS = 63_072_000;

/** External image CDNs the app renders directly via `<img>` (ADR 0009). */
const IMAGE_CDN_HOSTS = [
  // Numista coin-catalogue thumbnails.
  "https://en.numista.com",
  // CoinGecko token logos.
  "https://coin-images.coingecko.com",
] as const;

/** Report-only until observed clean; then this becomes `Content-Security-Policy`. */
export const CSP_HEADER_NAME = "Content-Security-Policy-Report-Only";

/**
 * Build the Content-Security-Policy value.
 *
 * @param dev - When true (i.e. `next dev`), `'unsafe-eval'` is added to
 *   `script-src` for HMR/turbopack. Production omits it so the observed
 *   report-only violations reflect the real deployed policy.
 */
export function buildContentSecurityPolicy({ dev }: { dev: boolean }): string {
  const scriptSrc = ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])];
  const directives: Array<[string, string[]]> = [
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
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
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
    { key: CSP_HEADER_NAME, value: buildContentSecurityPolicy({ dev }) },
  ];
}
