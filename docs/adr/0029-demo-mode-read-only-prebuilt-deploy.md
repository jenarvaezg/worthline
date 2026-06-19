# Demo mode is a read-only prebuilt deploy of the live app

We want to show worthline to people without exposing real holdings and without running
the live local app — a **demo mode** the public can click around. The obvious host was
GitHub Pages, but the app is the opposite of static: the dashboard is `force-dynamic`,
opens a real SQLite database through the native `better-sqlite3` module on every request,
and renders server-side; all in-page interactivity (Vista, drill, range, scope) is
query-param + cookie driven and **re-rendered on the server per navigation** (ADR 0009,
"zero client JS"). A static export would freeze each route to one default state and kill
that interactivity unless rebuilt client-side — which contradicts 0009. We instead deploy
the **same app, unchanged in shape, as its own read-only Vercel project** over curated
fictional data. A `DEMO` flag swaps the store to a bundled per-**persona** SQLite fixture
(copied to Vercel's writable `/tmp` and opened there), pins the clock, and blocks every
user write and outbound call at the server-action seam; destructive UI is hidden and
**exporting** stays live. Persona selection is a cookie set from a `/demo` landing page.
Authenticated, mutable, persistent cloud hosting of the _real_ workspace is explicitly
**out of scope** here.

## Considered options

- **Static export to GitHub Pages** — rejected: `force-dynamic`, `cookies()`, and
  server-read `searchParams` are all incompatible with `output: export`, and the export
  freezes each route to its default state, so the Vista/drill/range/scope controls go dead
  unless reimplemented as client JS — a direct violation of ADR 0009. The native module is
  not the blocker (it would run at build time); the server-per-navigation interaction model
  is.
- **Cloudflare Pages / Workers** — rejected: they run on V8 isolates with no native Node
  modules, so `better-sqlite3` cannot load at all. Shipping there would force rewriting the
  whole `packages/db` driver (to D1) _before_ a demo could exist.
- **A client-side, in-browser demo** (port the read path, or run SQLite via WASM) — rejected:
  the store layer is node-only (drizzle's `better-sqlite3` driver) and tightly coupled to the
  read/ripple machinery; reimplementing it client-side is a large lift, and ADR-adjacent
  history (#280) already reverted a domain→WASM port as overkill absent a concrete edge/mobile
  need.
- **Open the demo connection `readonly: true`** — rejected: the read path itself writes — the
  bootstrap healthcheck stamps `app_settings`, snapshots auto-capture, and price refresh
  upserts the cache — so a read-only connection crashes on a plain page view. Running on a
  throwaway `/tmp` copy lets those _involuntary_ writes succeed harmlessly without hunting
  down and gating each one; _user_ writes are blocked one layer up.
- **Random pre-populated data** — rejected: random numbers produce implausible portfolios
  (a mortgage larger than the house, negative net worth) and exercise the headline features
  only by accident. A demo is a pitch, so the data is curated, deterministic, and partitioned
  across three personas that together cover every rung, method, connected sources, FIRE,
  history, and scopes.

## Consequences

- A new `DEMO` gate threads through **one** centralized store-opening seam (the eight current
  `createWorthlineStore()` call sites collapse behind it) plus the server-action layer. With
  `DEMO` unset the live build is byte-for-byte unaffected.
- The demo's history is generated **the faithful way** — the seed declares dated facts
  (mortgage disbursement, operations, valuation anchors) and lets the existing **ripple**
  seams compute the snapshots, exactly as a real user's would. No hand-written synthetic
  snapshot rows, so the demo cannot drift from how the engine actually behaves.
- The clock is **pinned** via `WORTHLINE_DEMO_NOW`, read by both the seed and the running app;
  each persona's history is generated _relative_ to it. The demo stays internally consistent
  however long after a build it is viewed, and refreshing it is "bump the constant and
  redeploy" — upgradable to a periodic cron-redeploy with no code change.
- Writes and outbound calls (price refresh, Numista/Binance sync) are short-circuited at the
  action seam with a friendly "deshabilitado en la demo". Create/edit/puesta-al-día forms
  stay **viewable** (they are part of the product worth showing); reset, hard-delete, and
  import are **hidden**; export stays live (read-only and harmless).
- Persona is a `wl_demo_persona` cookie (mirroring `wl_scope`), set from the `/demo` landing
  and a shareable `/demo?persona=…` deep-link; switching clears `wl_scope` so a stale member
  scope cannot point at a persona that lacks that member. A cold first visit defaults to
  **familia**.
- No fixtures are committed or pre-bundled: the store seam **lazily seeds** each persona's
  SQLite into the writable `/tmp` on first use, from the declarative per-persona specs (the
  seed builder is the single source of truth). Git stays free of binary blobs and the build
  clones only the public repo — never `.local` — so there is no path for real data to leak
  into the demo. (Build-time fixture generation + `outputFileTracingIncludes` was the original
  plan — see the build-fixtures follow-up; deferred as an optimization, not needed for
  correctness.)
- **Deployment is _prebuilt_, not Vercel-built** (despite this ADR's original title). Vercel's
  build sandbox silently kills the Next 16 production build — `exit 1` right after "Skipping
  validation of types", on both Turbopack and webpack — on every Node version Vercel offers (22
  and 24); only Node 26, which Vercel cannot run, is unaffected. The app itself is healthy: it
  builds on Node 22/24/26 off Vercel (GitHub Actions, CI, Docker, locally), and `better-sqlite3`
  loads fine on the Vercel lambda (verified) — the **builder**, not the native module, is the
  blocker. So a GitHub Action (`.github/workflows/deploy-demo.yml`) builds the output on a
  Node 24 runner and ships it with `vercel deploy --prebuilt`; Vercel never runs its own
  builder. The build Node must equal the lambda Node (both 24 — Vercel's default; pinned via
  `engines.node`) or the native `better-sqlite3` binary
  ABI-mismatches at runtime. `vercel.json` disables Vercel's git auto-build (only the Action
  deploys), and public access required turning off Vercel **Deployment Protection** (on by
  default → 401 for everyone).
- This does **not** solve hosting the real, authenticated, mutable workspace in the cloud —
  that needs auth and a persistent hosted DB (libSQL/Turso is the closest-to-SQLite path) and
  is left for a separate effort. The demo seam is deliberately shaped not to block it.
