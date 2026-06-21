# The hosted app is multi-tenant: one libSQL database per workspace behind Google sign-in

worthline began local-first and single-tenant: one SQLite file _is_ one **workspace**,
pinned by a `CHECK (id = 'default')` constraint and opened synchronously through the
native `better-sqlite3` module. ADR 0029 deployed only a read-only **demo** of that app
and explicitly left "the real, authenticated, mutable workspace in the cloud" for a
separate effort. This is that effort. We make the deployed app **multi-tenant and
authenticated**: each **workspace** becomes its own libSQL/Turso database; a **user**
signs in with Google (Auth.js v5, JWT sessions) and is granted access to one or more
workspaces; and a small **control-plane** database maps users → workspaces → access
grants. The single-tenant data model is otherwise untouched — `id = 'default'` still
holds _inside_ each per-workspace database, so every domain query, the **ripple**
machinery, and **export/import** keep working verbatim; only the database the **store
seam** opens changes (from a local file path to a libSQL URL). One deployment serves
three request states — authenticated workspace, logged-out **demo** **persona**, and an
unauthenticated landing — so the demo folds into the real app instead of being its own
project. This is chosen deliberately for low traffic and minimal moving parts: the
"weird-but-viable" stage before a heavier datastore, not a permanent commitment.

## Considered options

- **Database-per-workspace on libSQL/Turso** (chosen) — preserves every query and the
  `id = 'default'` singleton; tenant isolation is _structural_ (no other tenant's row is
  reachable), matching how workspaces are islands by design; maps natively to Turso's
  per-tenant database model and its programmatic provisioning (`@tursodatabase/api`); and
  is free at this scale (100 databases on the free tier). The cost: the synchronous
  `better-sqlite3` store becomes **async** (libSQL is HTTP) — a broad but mechanical
  refactor of the `*-store` modules and the seam — while the pure domain math stays
  synchronous (the store `await`s raw rows, then hands them to `projectAssets` as today).
- **Shared database + `workspace_id` column** — rejected: drops the singleton CHECK and
  threads a tenant id through every table and every query in all six `*-store` modules; a
  single missing `WHERE workspace_id =` is a cross-tenant data breach; and it fights
  export/import's whole-workspace full-replace shape. The only thing it buys — cheap
  cross-workspace analytics — is a non-goal for islands-by-design personal finance.
- **Cloudflare Workers + D1** — rejected: re-platforms Next off the deploy just
  stabilized in ADR 0029, and D1's largely-static per-Worker bindings fight "open an
  arbitrary workspace database per request," which Turso does natively. (Workers also ban
  native modules, but `better-sqlite3` is being dropped regardless.)
- **Keep `better-sqlite3`, persist on the Vercel filesystem** — rejected: Vercel functions
  have an ephemeral filesystem not shared across instances, so file-based SQLite cannot
  durably hold multi-user writes — the exact reason ADR 0029's demo had to be read-only.
- **Firebase Auth** — rejected for v1: client-SDK-first, so server-side identity in a
  fully server-rendered app needs the Admin SDK plus session-cookie minting, fighting the
  `await auth()` grain Auth.js gives directly. Sign-in is **Google-only at launch**; the
  provider set stays trivially extensible.

## Consequences

- **The store seam (`apps/web/app/store.ts`) becomes the request resolver** for three
  states: an authenticated request opens the user's **workspace** database (URL looked up
  in the control plane; one shared Turso **group token** in env); a logged-out `/demo`
  request opens an **ephemeral in-memory libSQL** database seeded per request from the
  existing persona specs (no Turso quota; "nothing the viewer does persists" by
  construction); an unauthenticated non-demo request lands on a sign-in / "probar la demo"
  page. The deploy-wide `DEMO` flag from ADR 0029 retires — demo is now per-request (the
  persona cookie). The server-action **write-guard** stays, scoped to demo sessions.
- **Local dev and tests are preserved untouched.** `@libsql/client` speaks `:memory:`
  (tests), `file:` (local dev), and `libsql://` (prod) through one async API, so the
  driver swap is otherwise a URL change. An env short-circuit keeps a **no-auth local
  single-user mode** — auth, provisioning, and the control plane engage only in the real
  deployment — so daily development and the offline vitest/e2e suites run exactly as
  before.
- **Provisioning is on-first-login.** A Google identity with no access grant triggers
  `databases.create()` → migrate the fresh database → insert `workspaces` + `grants` rows
  → land in the existing `/empezar` onboarding. The control plane is itself one libSQL
  database (`users`, `workspaces`, `grants`); JWT sessions mean there is no session table.
  Future N-users-per-household (by **invitation**) is just new `grants` rows — no data
  migration — because the database is keyed by workspace, never by user.
- **Migrations run per workspace, on open, behind a version fast-path.** The bespoke
  idempotent `migrate.ts` (DDL _and_ data backfills) is unchanged; it runs against
  whichever workspace database is opened, short-circuited by a `user_version` check so
  steady-state cost is one cheap read. The first request to touch a workspace after a
  deploy pays the migration; a deploy-time batch runner is deferred until scale needs it.
- **Local ↔ prod sync reuses export/import.** `sync:pull` exports the prod **workspace**
  and imports it into the local file; `sync:push` does the reverse. The export carries the
  **full frozen snapshot history** (ADR 0010 / 0012 / 0015), so history round-trips — not
  just current balances. `push` is a destructive full-replace, so it auto-backs-up prod
  first and aborts if prod changed since the last pull. This also subsumes the one-time
  initial load of real data into prod.
- **Connected-source secrets change risk profile, so they are hardened (extends ADR
  0016).** `credentials_json` / `token_json` — a trade-capable Binance signing secret among
  them — are now **encrypted at rest** with an env key before reaching Turso; the hosted
  app **requires / strongly warns for read-only** API keys (worthline only ever reads
  balances). Secrets **stay out of exports** (ADR 0016 holds), so `sync:push` snapshots
  prod's connected-source secrets across the full-replace and re-applies them, never
  severing the live connection.
- **The native-build saga (ADR 0029) ends.** Dropping the `better-sqlite3` native addon for
  a pure-JS libSQL HTTP client removes the ABI matching and the Vercel build-sandbox
  failure that forced the prebuilt-via-GitHub-Action deploy; Vercel can build the app
  normally again.
- **Supersedes** ADR 0029's "the whole deployment is the demo" and "real hosting is out of
  scope" stances; **extends** ADR 0016 (connected-source secrets) for the hosted
  deployment. Calculations are identical local or hosted — ADR 0009 server-rendering and
  the **ripple** seams are untouched.
- **This is the low-traffic stage, explicitly.** Database-per-workspace, migrate-on-open,
  and a single group token are right for a handful of users; hundreds would want per-
  database tokens, a deploy-time migration runner, and possibly a heavier datastore. The
  seam and control-plane indirection are shaped so that swap stays contained.
- **Scaling trigger and the shared-table option (refined 2026-06-21).** The binding limit
  is Turso's free tier: **100 databases**, so the control plane + N per-workspace databases
  cap onboarding at ~99 users (the **demo** is ephemeral in-memory and consumes no quota).
  The first response to approaching that ceiling is **not** a re-architecture — it is the
  **Turso Developer plan** (~$5/mo at time of writing: unlimited databases, 500
  monthly-active), billed cleanly through the **native Turso↔Vercel Marketplace
  integration** (whose "Per User Starter" template is exactly this database-per-workspace
  shape). That is a billing toggle, not a migration, and at the project's expected scale it
  may never be needed. The **shared-database + `workspace_id`** alternative rejected above
  stays a _reserved option_, to be exercised only if (a) Turso's pricing becomes
  unacceptable, or (b) active-workspace scale outgrows the Scaler plan's economics.
  Deferring costs nothing because this ADR's store seam keeps that swap contained; doing it
  preemptively would trade away the `id = 'default'` singleton's simplicity — and force
  **export/import** to become tenant-surgical (per-`workspace_id` row replacement instead of
  whole-database replace, the riskiest part) — to save a trivial monthly fee. YAGNI holds:
  the option is preserved, so it is exercised when forced, not before.
