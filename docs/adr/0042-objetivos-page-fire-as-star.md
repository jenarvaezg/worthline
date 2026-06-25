# /objetivos consolidates FIRE and goals on one page, with FIRE as the star

## Context

Before PRD #507, FIRE detail (projection card, scenarios, trajectory) lived on the home `/` alongside goals CRUD in `/ajustes`. This scattered the "a dónde voy" surface across two sections and buried FIRE among settings.

PRD #507 proposes a dedicated `/objetivos` page as the user's forward-looking hub, with FIRE as the primary object and goals below it.

## Decision

**Information architecture**

- `/objetivos` is the single "a dónde voy" surface: FIRE star hero at the top, read-only goals list below.
- The home (`/`) keeps only a compact FIRE glance card (% funded, bar, coast tick, years-to-FIRE, goal count). The «Ver objetivos →» link on the home card points to `/objetivos`.
- Goals CRUD (create / edit / delete) moves out of `/ajustes` into `/objetivos` (S3, #511). `/ajustes` retains FIRE **assumptions** (monthly spending, withdrawal rate, return, ages) — the inputs, not the output.
- Nav order: Resumen · Patrimonio · Histórico · **Objetivos** · Ajustes.

**FIRE star layout**

The hero panel shows: large % funded, progress bar with coast tick, Coast-FIRE explainer, FIRE number, eligible assets, coast required/age, the 3-scenario `FireProjectionCard` (reused from S1, extracted component), and the «¿qué cuenta como elegible?» disclosure. Server-rendered SVG trajectory (ADR 0032).

**The `prepareObjetivosState` domain seam**

All FIRE data for `/objetivos` is derived by composing `prepareDashboardState` — not re-deriving projection/reservation/funded math. `prepareObjetivosState` adds per-goal `fundedRatioBps` / `reservedMinor` views using the existing `goalFundedRatioBps` / `goalReservedMinor` helpers. Zero parallel math.

**The "+X meses" goal-delay metric (S4, #512)**

The metric answers: how many months does **this specific goal** delay my FIRE date? It is **per-goal and marginal**: each goal's delay is measured by holding all other in-horizon reservations constant and asking "what if only this goal were removed?"

Implementation (`goalFireDelay` in `packages/domain/src/goal-fire-delay.ts`):

1. **Horizon guard**: use `fireReservationHorizon(config, now)` — the same function used by `countsTowardFire` and `totalGoalReservationMinor` — to decide whether the goal is in-horizon. A goal whose deadline ≥ horizon (or with no horizon due to missing `currentAge`) returns `no_effect`. This is the single source of truth; `projectFire`'s `yearsToFire` is never used as a second horizon check.

2. **Two projections on the base scenario**:
   - WITHOUT: `startingEligible = eligibleGross − otherReservations` (other in-horizon goals reserved, this one removed)
   - WITH: `startingEligible = eligibleGross − otherReservations − thisGoalReservation`
     The helper calls `projectFire` twice itself — it does **not** reuse `dash.fireProjection`; each call is a fresh projection for that specific starting capital.

3. **Fractional interpolation**: linear interpolation between the two trajectory points straddling `fireNumberMinor` gives a fractional crossing year; `round(Δfrac × 12)` gives months. Month counts are not multiples of 12 in general.

4. **Marginal semantics**: individual deltas do not sum to a "total goals delay" (non-linear compounding). That is expected and correct.

5. **In-horizon reservation input**: the caller (`prepareObjetivosState`) passes the pre-computed `goalReservationMap.get(goal.id)` value so the helper subtracts exactly what FIRE subtracts — no independent re-derivation.

This introduces `goalFireDelay` as the 5th consumer of the reservation path (after dashboard, MCP, home glance, and the per-goal funded-ratio view). Any change to the reservation rule must update all five.

## Considered options

- **FIRE detail on the home, goals in ajustes (rejected).** Scatters the forward-looking surface; FIRE detail is too large for a summary page.
- **Separate `/fire` and `/objetivos` pages (rejected).** FIRE is the primary goal; goals reserve capital against FIRE — they belong together, not split.
- **Goals CRUD stays in ajustes (deferred to S3).** S2 ships read-only goals; CRUD moves in S3 (#511) once the page is established.

## Consequences

- Nav gains an "Objetivos" entry (5th item). Shell `AppSection` union updated.
- `prepareDashboardState` is composed, not bypassed — FIRE data stays consistent between the home glance and the `/objetivos` detail.
- `FireProjectionCard` is reused without forking; the trajectory SVG renders taller on `/objetivos` via a single CSS override (`.objetivosHeroRight .fireTrajectory { height: 150px }`), not a prop.
- **Drift watch**: `totalGoalReservationMinor` is now consumed in 4 places (dashboard, MCP, home glance, objetivos). Any change to the reservation rule must update all four. The "+X meses" S4 implementation adds a 5th.
