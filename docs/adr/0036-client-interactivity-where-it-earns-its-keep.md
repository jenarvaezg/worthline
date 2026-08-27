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

## Amendment (#1270): a native fold's `open` belongs to the DOM, and says so

The folds this ADR keeps — native `<details>`, no client JS — are toggled by the
**browser**, not by React. A person can open one before the page hydrates (slow
network, cold route), and React then finds an attribute it did not write: _"A tree
hydrated but some attributes of the server rendered HTML didn't match the client
properties. This won't be patched up."_ A real `console.error`, in a real person's
console, for behaviour that was entirely correct — their click.

So every `<details>` in the app carries `suppressHydrationWarning`: not a silencer, a
statement of ownership. `apps/web/app/fold-hydration-guardian.test.ts` enforces it and
`e2e/49-fold-before-hydration.spec.ts` proves it holds — reproducing the window by
holding the route's JS chunks, so it guards the production build too.

The rule is unconditional **because no fold here derives `open` from client state**:
`open={editing}` reads a server-side form error and `open` is a literal, so the browser
owns the toggle in both cases — and a fold sent open mismatches in the other direction
when it is clicked shut early. A fold whose `open` ever came from `useState` would make
React the owner; that is the moment to revisit this rule, not a reason to carve an
exemption into it now.

## Amendment (#1379): the View Transitions leg is retired — the shell was doing the work

The chosen option above lists "the View Transitions API for flash-free navigation" as
one of its four legs. That leg **never ran a single time**. Measured on a production
build (`build:e2e` + `CI=1`) with `document.startViewTransition` wrapped in an init
script, navigating the topnav dozens of times with and without CPU throttling:
**zero calls**.

The reason is structural, not a misconfiguration. React decides whether to open a
transition through an internal `shouldStartViewTransition` flag that is set **only**
from `<ViewTransition>` fibers; with no boundary in the tree, `commitRoot` takes the
ordinary branch. Next's client runtime does not add a boundary either — `transitionTypes`
on `<Link>` calls `addTransitionType`, which queues a type for the next transition, and
if no transition starts, nothing is queued. `experimental.viewTransition: true` only
resolves a React build that *exports* the component; it does not mount one.

We **retired** the layer instead of adding the boundary, for three reasons:

1. **What reviving it buys is one page-root cross-fade.** #640 already deleted the
   directional slide selectors, so `slide-forward` and `slide-back` would have painted
   exactly what `cross-fade` paints. The classification module was computing a
   distinction no stylesheet consumed.
2. **A cross-fade fades into a skeleton.** A view transition snapshots the outgoing page
   and fades toward the incoming page's *initial* state. Every section page streams under
   `<Suspense>` and there is no `loading.tsx`, so that initial state is the skeleton: a
   polished fade, then an unanimated pop to content. §5's "no flash" promise is kept today
   by the prefetched shell and the skeletons (#1229), not by any transition.
3. **The boundary would move the outgoing route's hide inside the transition callback.**
   Under `cacheComponents` that hide is what #1296 (document-height collapse) and #1351
   (late reveal) turn on. Re-opening that mechanism to buy a fundido is a bad trade.

What was kept: `NavPendingIndicator` + `useLinkStatus` (`app/nav-link.tsx`), the in-flight
marker that lived in the same component and never depended on the transition.

The retirement is guarded by `app/retired-view-transitions.test.ts`, which fails if the
pseudo-element rules or the `experimental.viewTransition` flag come back — the flag alone
recreates the inert layer, and an inert layer is not free: the opening hypothesis of #1351
was "a transition that never closes", and there was no transition.

**If View Transitions are ever wanted here, the case is element continuity, not page
cross-fade** — a shared `view-transition-name` on a position card growing into its
drilldown, which CSS cannot imitate. That is a new proposal with its own measurement,
not a revival of this one.

## Amendment (#1311): a refusal's terminal is returned state, never a navigation

§4 of `interaction-patterns.md` says a failed mutation "shows the error". It did not
say **how the error travels**, and the how turned out to decide whether it arrives at
all. A validation error's reason reached the server, was refused in 64 ms with a
message, and never made it to the screen: an emptied form, no band, no URL change,
and not one further request. It ran as a ~2,7 %-per-run CI flake for months (#1311)
and never reproduced on a developer machine.

The cause is structural, in Next 16.3's client runtime, and it is worth writing down
because it applies to **every** mutation terminal we deliver with `redirect()`:

1. The server answers 303 + `x-action-redirect`. The client's `server-action-reducer`
   rejects the action promise with a redirect error marked `handled`, and
   `RedirectErrorBoundary` — seeing `handled` — remounts the subtree **without
   navigating**. So the emptied form is the boundary's doing, and the navigation rides
   only on the state the reducer returns.
2. `dispatchAction` (`app-router-instance.js`) marks the pending action `discarded`
   the instant an `ACTION_NAVIGATE` or `ACTION_RESTORE` arrives, and `handleResult`
   then never applies that state. The redirect dies with it.
3. The one recovery, `actionQueue.needsRefresh`, is gated on `didRevalidate`. A
   **success** revalidates (`invalidateRouterCache`, #1191) and therefore has a net;
   a **refusal** mutated nothing, revalidates nothing, and is irrecoverable **by
   design**.

Next also patches `pushState`/`replaceState` to dispatch `ACTION_RESTORE`, so any of
our own URL-mirroring islands (§3) firing during a submit is enough to trigger it.

**Decision: the mutation terminal is split.** Success keeps its redirect — it
revalidates, so it both needs the fresh destination and carries the net. A refusal
comes back as **returned state**, rendered in place. The reducer calls
`resolve(actionResult)` from inside itself, before and independently of the
`discarded` check, and with no redirect and no revalidation it leaves through the
bail-out without touching the router: there is no navigation to lose.

The door is `formActionInlineError` (`app/form-action.ts`), a third form of the
`formAction` combinator. A submit opts in with `inlineError=1`, stamped in the submit
handler and never in the rendered HTML — a form posted with JavaScript off cannot
carry it and keeps the redirect terminal, the only one it can render. With JS on,
**every** submit must leave from our handler: React does not do a document post, it
sends the same server action, so delegating to it hands the refusal back to the
losable terminal.

Rejected: **revalidating on the error path too**, to buy the `needsRefresh` net. It
was the candidate the issue carried, and it does not work — `ACTION_REFRESH`
re-renders the CURRENT route, so it would never deliver a destination carrying the
reason. It would also invalidate caches for a write that changed nothing.

What this also buys, and what journey 52 pins: typed amounts stop riding the address
bar, the fold the person opened stays open, and what they typed stays in its field.
The same journey holds the deterministic reproduction — it pushes a history entry
while the action is held — so the next change here is measured in seconds instead of
100+ CI runs.

Scope: the operations form is the first caller. The remaining error paths still
redirect; migrating them is pending work with the pattern already proven.
