# Client interactivity where it earns its keep: RSC-first, not zero-JS

ADR 0009 made the dashboard **deliberately zero-client-JS**: server components,
server-rendered SVG charts, native `<details>`, links and forms for everything, with a
single `"use client"` escape hatch for the composition-chart tooltip (#143). That posture
was correct for a **local** app on synchronous `better-sqlite3`, where a full-document
server navigation was sub-millisecond and felt instant. Two things changed it. First, the
hosted move to remote libSQL/Turso (ADR 0030) turned **every** server navigation into a
network round-trip, so the same zero-JS model now surfaces as flashes, scroll jumps and
perceived lag on every framing toggle, range/density change and drilldown. Second, the
zero-JS rule caps **interaction**: no optimistic mutations, no cursor-following charts,
and view toggles that should be free instead round-trip. The driver is **experience**, not
missing features — the technology is just the vehicle. We relax the default from "zero
client JS" to **"client interactivity where it earns its keep,"** staying RSC-first.

## Considered options

- **RSC-first with targeted client interactivity** (chosen) — keep server components and
  server-rendered figures/charts; add client only where interaction lives. Concretely:
  the View Transitions API for flash-free navigation; ephemeral **view toggles** (the
  framing "Vista", histórico range/density) become client state so they no longer
  round-trip (the server sends the data once, the client switches); `useOptimistic` +
  Server Actions on the existing mutations for instant inline feedback; interactive chart
  **islands** that wrap the existing pure SVG-geometry functions (cursor tooltips, hover,
  zoom); and an installable **PWA** shell. Preserves instant first paint (the figures
  render on the server — a feature for a finance dashboard, not a limitation), keeps the
  domain math server-side, ships **no API**, costs **$0**, and is the intended grain of
  Next 16 / React 19. ADR 0009 pre-authorized the chart part: _"If rich cursor-following
  interactivity is ever wanted, the cost is migrating individual chart components, not the
  page architecture."_
- **Hybrid client surfaces + read API** — rejected for now: the interactive surfaces
  (patrimonio, histórico) fetch from a thin read API and hold data client-side for instant
  filtering and real offline. It buys a genuine ceiling (instant-over-preloaded data, true
  offline) but costs a read API, the **loss of server-render on the heaviest surface** (a
  spinner before the numbers — a regression for a dashboard whose whole value is the
  figures), and materially more JS. **Reserved surface-by-surface**: if a specific screen
  still feels server-bound after the chosen option, _that_ screen is clientified — not the
  app.
- **Full SPA + API** — rejected: the same "re-architect for a hypothetical" trap the data
  layer was just spared (ADR 0030 scaling-trigger note). It would be justified only by a
  concrete native-mobile plan, which does not exist — and mobile is served by the PWA, not
  a native app plus an API.

## Consequences

- **ADR 0009's "zero-client-JS" _default_ is superseded; its _principles_ survive.** The
  figures are still server-rendered; chart geometry stays pure tested functions in
  `packages/domain`; client islands **wrap** that geometry for interaction rather than
  replacing it with a charting library by default. The lone composition-chart island (#143)
  stops being an exception and becomes the pattern.
- **No API is built.** A future mobile client is served as an installable **PWA** — the
  same web app plus a manifest and a service worker — and code reuse for it stays via the
  shared `@worthline/domain` packages, never a separate API, until/unless a concrete native
  plan forces one. "Future Android" does not drive this architecture.
- **The PWA service worker caches the app shell; data stays network-first.** The figures
  are authoritative and server-computed, so the shell can be cached for installability and
  fast paint while reads still go to the server.
- **Decoupled from the data layer.** This is the front-only initiative; the data-layer
  re-architecture was deliberately deferred (ADR 0030). Neither blocks the other.
- **Escalation stays contained.** Nothing here forecloses moving a single surface to the
  hybrid client model later if it proves server-bound; the boundary is per-surface, like
  ADR 0009's chart escape hatch.
