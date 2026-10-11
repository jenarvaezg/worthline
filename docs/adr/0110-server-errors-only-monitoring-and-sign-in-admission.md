# Server errors go to Sentry without their text, and sign-in admits before it provisions

Two structural decisions of the ops fuses (#1175, PRD #1171 S4), recorded together
because both reshape a seam that other work leans on: what may leave the server about a
failure, and which Auth.js callback owns provision-on-first-login (ADR 0030).

## 1. Error monitoring: server only, errors only, no free text

worthline promises no usage telemetry (#1131, CONTEXT.md). The product needs to know when
the server breaks, and Sentry is the one processor admitted for it. It is declared in the
privacy policy, and it receives exactly this:

- **Server only.** `@sentry/nextjs` runs in the Node runtime, loaded from
  `instrumentation.ts` only when `SENTRY_DSN` is set, and errors reach it through
  `onRequestError` (RSC renders, route handlers, server actions, the proxy). The browser
  bundle ships no Sentry. The enforced CSP keeps `connect-src 'self'` precisely because no
  client code talks to a third party (`security-headers.ts`). A browser SDK would either
  break that or need a tunnel route through the auth proxy, and it would ship an SDK to
  every page. Errors that happen only in the client are therefore not reported. That gap is
  accepted and recorded as a follow-up.
- **Errors only.** No `tracesSampleRate` is defined: defining it, even as 0, turns the
  tracing machinery on. OpenTelemetry setup is off. Transactions are dropped, and the
  `SENTRY_TRACES_SAMPLE_RATE` env var is removed before init. Spotlight is off, because the
  option overrides `SENTRY_SPOTLIGHT`. Breadcrumbs, logs, metrics and client reports are
  dropped, and nothing is propagated to third parties. `dataCollection` is off entirely:
  v11 collects everything when it is left unset. Integrations go through an **allowlist**,
  so whatever a future SDK version adds by default stays off.
- **No free text.** `beforeSend` rebuilds every event from an allowlist: the error class,
  the frames (file, function, line, column), the route **pattern**, runtime and OS. Every
  message is replaced by a marker. An error message is the one field where interpolated
  user input can ride along (a holding's label, a typed figure), and no redaction rule can
  promise to catch all of it. The privacy text can then promise in absolute terms that the
  error's text, the person and their workspace never leave. The marker carries the React
  `digest` Next.js stamps on render errors when there is one. That digest also sits next to
  the full error in the deployment's runtime logs (Vercel, already a processor). So Sentry
  says *that* something broke, where and how often, and the logs say *what*.
- **No source maps yet.** No `withSentryConfig`: wrapping `next.config` changes the build,
  and the build/packaging path is where the 2026-07-10 incident lived
  (`docs/agents/incident-2026-07-10-vercel-cli-500.md`). Server bundles are minified, so
  frames read as minified names until the upload exists. Uploading source maps
  (`withSentryConfig` or `sentry-cli` in `deploy.yml`) is the follow-up. The
  frame-rewriting integrations are left out of the allowlist until then.

## 2. Provisioning moves from `jwt` to `signIn`

The daily provisioning cap must be able to **refuse** a new identity with the honest «hoy
estamos llenos, vuelve mañana». Only Auth.js's `signIn` callback can refuse with a
redirect. A throw from `jwt` lands on the generic server-error page, and returning `null`
silently drops the session. So `signIn` now resolves the workspace, creating and migrating
it the first time, and returns either `true` or the `/login?registro=lleno` path.

Two consequences:

- A real provisioning failure inside `signIn` is rethrown as an `AuthError`. Auth.js reads a
  plain throw from `signIn` as `AccessDenied`, «you do not have permission», which would
  lie. An `AuthError` lands on the same server-error page a failure in `jwt` always showed.
- `jwt` still pins the workspace into the token. To avoid opening the control plane a second
  time per login (with its schema bootstrap), the auth route runs each request inside a
  request-scoped `AsyncLocalStorage` handoff (`sign-in-handoff.ts`). `signIn` leaves the
  resolved workspace there and `jwt` takes it. Nothing survives the request. Without a
  handoff, `jwt` resolves the workspace itself. That path is slower but gives the same
  answer, and it never refuses an existing user, because the provisioner resolves returning
  identities before it consults the cap.

The cap itself is in the provisioner and the control plane (`daily-provisioning-cap.ts`).
It refuses only new workspaces. Outside production an unset variable means no cap. In a
production deploy an unset variable fails closed for new sign-ups, just like an unreadable
value, so a forgotten variable cannot silently reopen #733's open registration. That is not
a boot refusal: refusing to boot would lock out existing users too. Its maintainer alert is
the `provisioning_cap` amendment of ADR 0064.

## Considered options

- **Redact the message by pattern instead of dropping it.** Rejected: redaction is a promise
  about every message any library or line of ours may ever build, and it cannot be kept.
  The digest bridge keeps the diagnosis reachable without sending text.
- **A browser SDK behind a tunnel route.** Deferred: it widens the CSP or the proxy, adds
  per-page weight, and reports interaction-shaped data that the no-telemetry promise would
  then have to fence. Revisit with a concrete client-error need.
- **Keep provisioning in `jwt` and route errors to `/login` via `pages.error`.** Rejected:
  the only client-safe error type is `AccessDenied`, which would overload a meaning, and
  every other Auth.js error would change its landing page in passing.
- **Pass data between callbacks by mutating Auth.js's `user` object.** Rejected: it works
  only because of object identity inside a beta library. The request-scoped handoff is
  ours and explicit.

## Consequences

- The privacy policy states literally what the code sends, and the scrubber's tests are that
  sentence.
- Sentry is an alerting and aggregation channel. The detail of an error lives in the runtime
  logs, reachable by digest, until source maps land.
- A login opens the control plane once. Provisioning, the cap and its refusal all happen in
  `signIn`.
