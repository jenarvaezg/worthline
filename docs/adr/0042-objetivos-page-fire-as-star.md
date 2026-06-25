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

The conservative metric answers: how many extra months of work do your goals add to FIRE? Implementation: run `projectFire` once with `totalGoalReservationMinor` included (the real path), once with reservation = 0 (the hypothetical), and subtract the base-scenario crossing years, interpolating within the crossing year for month-level precision.

This is a **single reuse** of the reservation path already threaded through `prepareDashboardState` → `calculateFireForScope` → `projectFire`. No new projection consumer is introduced — it reuses `totalGoalReservationMinor` (the 4th consistent consumer after the dashboard, the MCP, and the home glance), and calls `projectFire` twice with different reservation inputs. The conservative bias is deliberate: it uses the "remove-from-now" approach (goals reserved today, goals removed today) rather than a forward-looking what-if, matching the engine's annual granularity.

## Considered options

- **FIRE detail on the home, goals in ajustes (rejected).** Scatters the forward-looking surface; FIRE detail is too large for a summary page.
- **Separate `/fire` and `/objetivos` pages (rejected).** FIRE is the primary goal; goals reserve capital against FIRE — they belong together, not split.
- **Goals CRUD stays in ajustes (deferred to S3).** S2 ships read-only goals; CRUD moves in S3 (#511) once the page is established.

## Consequences

- Nav gains an "Objetivos" entry (5th item). Shell `AppSection` union updated.
- `prepareDashboardState` is composed, not bypassed — FIRE data stays consistent between the home glance and the `/objetivos` detail.
- `FireProjectionCard` is reused without forking; the trajectory SVG renders taller on `/objetivos` via a single CSS override (`.objetivosHeroRight .fireTrajectory { height: 150px }`), not a prop.
- **Drift watch**: `totalGoalReservationMinor` is now consumed in 4 places (dashboard, MCP, home glance, objetivos). Any change to the reservation rule must update all four. The "+X meses" S4 implementation adds a 5th.
