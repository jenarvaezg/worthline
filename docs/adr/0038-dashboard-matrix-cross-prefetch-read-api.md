# Dashboard composition matrix: cross-prefetch over a scoped read API

ADR 0036 relaxed the dashboard from zero-JS to **RSC-first client interactivity** and
sketched Phase 0 as "the server sends the alternatives once, the client switches" with
**no new API**. S2 (#518, framing) and S3 (#519, range) followed that literally: the
server ships every alternative of one axis up front and an island toggles. That works for
a single axis. The composition surface has **two data axes** that combine, and shipping
their full product up front does not scale.

## The matrix

The composition panel is one of a small set of **view modes** drawn over one of a small
set of **temporal ranges**:

- **mode** (rows): the composition `chart`, plus the four drilldowns `liquid` / `rest` /
  `housing` / `debts` (#76, #77, #145). ~5 rows.
- **range** (columns): the offered windows `1y` / `3y` / `5y` / `all` (#144). ≤4 columns.

A **cell** `(mode, range)` is the data that mode needs at that range: for `chart`, the
`CompositionSeriesPoint[]` (`buildCompositionSeries`); for a drilldown, the
`DrilldownState` (`buildDrilldown`). Both are pure functions of the scope's windowed
holding rows + snapshots — no price refresh, no capture.

Two axes that are **orthogonal client toggles** sit on top of the chart cell and need **no
cell data of their own**: the framing `view` (total↔liquid) is hero-only (#518; the chart
and drilldowns are framing-independent), and `vivienda` (net↔hidden) only re-derives chart
geometry client-side via `buildCompositionChartGeometry(points, { housingMode })` from the
_same_ points. So the data matrix stays 2-D; those two are free client re-renders.

## Considered options

- **Ship the full matrix up front** — every cell on every load (~5×4 = 20 states). Pure
  Phase-0 grain, no API. Rejected: most cells are never opened; serializing 20
  drilldown/series states on every dashboard load is exactly the JS/payload bloat ADR 0036
  §11 warns against, and it grows with every new mode/range.
- **Ship only the active cell, navigate for the rest** — today's behaviour. Rejected: that
  is the ~2.3s Turso round-trip per toggle (S0 baseline #516) this whole phase exists to
  kill.
- **Cross-prefetch over a scoped read API** (chosen) — ship only the **cross** of the
  current cell on load, switch instantly within it, and prefetch the next cross in the
  background. This is the **Option B read API** ADR 0036 §10 reserves for a surface that
  has earned it — scoped to _this_ surface, not the app.

## Decision

### The cross invariant

From cell `(mode, range)`, a **single** user action moves one step along a row (change
range) or one step down a column (change mode) — never diagonally. So the only cells
reachable in one click are the current **row** (this mode at every range) and the current
**column** (every mode at this range): the **cross** centred on the current cell, ~(rows +
cols − 1) cells, not rows×cols. For 5×4 that is ≤8 cells, not 20.

- **On load**, the server ships the cross of the URL's cell. S3 already ships the chart
  row (`compositionSeriesByRange`); on a plain `chart`/`all` load the cross adds only the
  four drills at `all`.
- **On a click**, the target cell is — by the invariant — already in the shipped cross, so
  the island renders it from its in-memory cache **instantly, no fetch**.
- **After landing** on the new cell, the island prefetches that cell's cross over the read
  API and merges the missing cells into the cache, so the _next_ click is instant too. A
  cache miss (rapid clicks, cold prefetch, network failure) degrades to an honest inline
  pending and a foreground fetch (§9), never a stale figure.

### The read API

`GET /api/dashboard/cells` returns requested cells for the **session's own** workspace and
the request's scope. It is a pure read:

- **Tenant isolation is not a parameter.** The workspace is resolved by `withStore` /
  `readStoreTarget` from the Auth.js session JWT (or the demo persona cookie, or local
  no-auth) — exactly as the page does (ADR 0030). The scope is read from the `wl_scope`
  cookie server-side. The client supplies **only matrix coordinates** (`mode`, `range`);
  it can never name a workspace or scope. An unauthenticated request 401s like any page.
- **Side-effect free.** Unlike the page load it never refreshes prices or captures a
  snapshot; it reads the already-frozen snapshots + holding rows once and builds the
  requested cells with the same pure domain functions. Response is `Cache-Control:
no-store` (figures are authoritative and network-first, §9).
- **Bounded.** Coordinates are validated against the known mode/range vocabularies;
  unknown values are rejected, and the number of requested cells is capped at the matrix
  size so a crafted query cannot fan out work.
- **Demo** (logged-out persona cookie) resolves to the read-only in-memory persona store
  and works unchanged; it never fakes optimism (there are no mutations here).

### Where the logic lives (§7)

The cell vocabulary, the cross algorithm, the cache key, and the cache/prefetch diff are
**pure modules with `.test.ts`** (`dashboard-matrix.ts`). The island is a thin shell that
wires them to `fetch`, `pushState`/`popstate`, and the shared `VIEW_STATE_CHANGE_EVENT`
(#518/#519) so it composes with the framing and range islands through the URL. The
server-side cell building is the existing pure domain (`buildCompositionSeries`,
`buildDrilldown`) behind a single side-effect-free reader shared by the page and the route.

## Consequences

- The composition surface stops round-tripping on drill open/close and range change while
  shipping only ~(rows+cols) cells per load, not rows×cols — the payload stays flat as
  modes/ranges grow.
- A genuinely new surface — a same-origin authenticated read API — now exists. It is held
  to the page's tenant-isolation contract (workspace from the session, never the client)
  and is the **only** sanctioned client-data path (ADR 0036 §10); the rest of the app
  stays RSC-first with no API.
- The drilldown panel and the composition chart's drill/housing controls keep their real
  `<a href>` / server-link fallbacks (deep-link, no-JS, keyboard), with the island
  intercepting a plain click to toggle client-side — the established #518/#519 pattern.
- View Transitions (S1, #517) are **not** a prerequisite: with no document navigation the
  scroll position is preserved already; when S1 lands it adds the flash-free animation to
  the same client swap.
- Cross-panel reach: opening a drill from the liquidity donut (a different `<section>`)
  coordinates with the composition island through the URL + `VIEW_STATE_CHANGE_EVENT`, not
  a shared store (§10).
