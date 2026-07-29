# The CSP blocks everything except the framework's inline output

The Content-Security-Policy enforces every directive whose legitimate exceptions this
repo can enumerate or measure: `img-src`, `font-src`, `connect-src`, `object-src`,
`base-uri`, `form-action` and `frame-ancestors`. Three stay in
`Content-Security-Policy-Report-Only` and are expected to stay there: `script-src`,
`style-src`, and `default-src` — which is only listed because it is their fallback, so
enforcing it would enforce them through the back door.

The reason is not missing evidence. It is that both need `'unsafe-inline'` to work at
all. Next emits an inline bootstrap script and inline hydration payloads on every
page; styled-jsx, inline `style` attributes and the View Transitions API all emit
inline styles (ADR 0036). An enforced `script-src` that keeps `'unsafe-inline'` buys
nothing — an injected inline `<script>` is exactly what it would still admit — so
enforcing it is not a smaller version of the same decision. It is all or nothing, and
the "all" is a nonce.

## What a nonce would cost

The earlier note in `security-headers.ts` said a nonce was impossible because the app
has no middleware. That was wrong: `apps/web/proxy.ts` is Next 16's middleware and
already runs on every matched request (it is the auth gate). The cost is real, but it
is elsewhere:

- **The policy is static config.** Both headers come from `next.config.ts` `headers()`,
  which is evaluated once and cannot carry a per-request value. A nonce would move the
  CSP into `proxy.ts`, whose matcher deliberately excludes `_next/static`,
  `_next/image`, `favicon.ico` and `*.png` — so the header would stop covering exactly
  the paths that are cheapest to serve and easiest to forget.
- **The nonce has to reach the HTML.** That means reading `headers()` in the root
  layout, which opts the whole tree out of static rendering. This app spent #1229 on
  the opposite: prerendered shells, instant navigations, a landing captured as static
  output. A nonce trades the rendering model for the directive.
- **The proxy is a load-bearing packaging risk.** The 2026-07-10 total outage was
  `proxy.ts` compiled to CJS inside an ESM package and `require()`d by a launcher the
  Vercel CLI changed under us; it is survived by a pin (`vercel@54.21.1`). Growing what
  the proxy does raises the stakes on that path.

## What reopens it

A Next release that lets `headers()` mint a per-request value, or a nonce mechanism
that does not force the root layout dynamic. Until then, the honest statement is that
XSS defense in this app rests on React escaping and the assistant's render seam
(#1246), not on `script-src`.

## Why there is no report endpoint

The policy declares no `report-uri`/`report-to`, and none is being built. The premise
that made one look necessary — that a report-only violation is invisible to us — is
measured false: Chrome logs report-only violations through `console.error`, and
`e2e/fixtures.ts` fails any journey that reports a console error. The main suite has
therefore been failing on report-only violations all along, which makes a green suite
positive evidence that the whole target policy is clean across everything the journeys
touch. That channel is executable in CI, unlike a report nobody reads.

The alternative is worse than useless: an unauthenticated public endpoint accepting
POSTs from any browser on the internet needs a rate limit (ADR 0051) and a body
ceiling before it is safe to deploy, and it would collect reports for the three
directives whose values are already known and deliberate.

The channel's limit is written where it matters: journeys only observe what they
exercise, so `img-src` is covered by measurement of the real data (#1272) rather than
by the suite.
