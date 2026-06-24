# A contribution plan is a forecast layer, reconciled to manual operations; it never enters net worth or snapshots

## Context

worthline's only forward-savings concept is `monthlySavingsCapacity` — a per-scope scalar (in `FireScopeConfig`) that `projectFire` adds as a flat, compounded annual contribution to one aggregate FIRE pot. There is no recurring/scheduled/planned cashflow model, no notion of **where** monthly capital goes, and no plan-vs-actual loop.

Two product goals motivate the gap: worthline should **unify all finances and replace the personal spreadsheet** — and "where does my capital go each month as it comes in" is exactly the spreadsheet it lacks — and it should be a **data source for agents** (expose it over the MCP). The value here is the monthly capital-allocation picture + a plan→actual reconciliation + a what-if + MCP exposure, **not** FIRE-projection accuracy (the scalar already feeds the projection).

The decisive reality: a planned purchase (e.g. an S&P-tracking pension-plan contribution) often executes **late**, and even on time, at an **unknown price**. Without open-banking it must be entered by hand. So a plan is an **intention**, never the truth — and worthline is manual-first, with **operations** as the truth ledger and **snapshots** reconciling to net worth (ADR 0008).

## Decision

A **contribution plan** is a **forecast layer**, distinct from the truth and reconciled into it by hand.

- A **planned contribution** is a recurring intended addition to one **holding**: a destination `holdingId` (any holding — an investment _or_ a cash account), an amount in **money or units**, a cadence (weekly by weekday / monthly by day-of-month / quarterly / annual), a start and an optional end. Destinations are **holdings only** — a holding already assigned to a goal funds it via `goal.assetIds`, so goals are not separate destinations.
- The plan **never enters net worth or a snapshot** — like an **exposure profile** (ADR 0039) and a **return** (ADR 0040), it is forecast/reference, not a figure the math reads. This keeps it clear of ADR 0008.
- **`monthlySavingsCapacity` becomes derived** — the sum of the active plan's monthly-equivalent contributions — with the manual scalar kept as the fallback when no plan exists. `projectFire` reads the derived value, so there are never two forward-savings inputs that disagree.
- **Reconciliation is manual and explicit, never auto-matched.** The plan emits expected **occurrences** (forecast: destination, planned date, planned amount/units) surfaced as a **pending list** (a pull, not a push). The user confirms via a small **pre-filled form**, correcting date / price / units to reality: an investment occurrence records a **buy operation**, a cash occurrence a **balance value-update**. States: **pending → fulfilled** (linked to the real movement) or **skipped**; past pending occurrences are a visible **backlog**. Truth changes only through the normal operation/value path — the one thing that ripples snapshots. worthline never silently matches an independently entered operation to an occurrence.
- The **what-if** extends `projectFire` with the plan's **time-varying** contributions plus a **growth-assumption toggle**: flat at current price, or **historical appreciation reusing the holding's own return from PRD #547** (falling back to an assumed rate when absent).
- The **MCP** exposes the plan, the monthly allocation view, the pending/backlog status, and the what-if — read-only, with forecast clearly labelled.

## Considered options

- **Keep only the scalar / do nothing (rejected).** It cannot express per-destination allocation, time-varying contributions, or the reconciliation loop; the spreadsheet-replacement and MCP goals justify a first-class object.
- **Free-text budget categories as destinations (rejected).** That turns worthline into a budgeting app; it is holdings-centric and manual-first, so destinations are real holdings.
- **Auto-match operations to plan occurrences (rejected).** Which buy matches which plan is fuzzy and error-prone; an explicit pre-filled confirm is honest and manual-first.
- **Treat the plan as truth / auto-create operations (rejected).** The plan is an intention; real execution differs in date, price and units, and worthline never writes truth automatically.
- **Two independent inputs — the scalar and the plan (rejected).** They would drift; the scalar becomes derived from the plan.
- **Open-banking / automatic import (out of scope).** The manual confirm loop is the deliberate stand-in until such an integration exists.

## Consequences

- worthline gains the spreadsheet layer (monthly capital allocation), a plan→actual reconciliation loop, a what-if, and MCP exposure — serving both stated goals.
- `monthlySavingsCapacity` is now derived — a new consumer of the forward-savings input; a **drift watch** with the FIRE reservation calc (#421 / #507) that already reuses it.
- The what-if's historical-growth toggle is a **soft dependency on #547** (returns); it falls back to an assumed rate without it.
- Forecast-only → no snapshot, net-worth, or reconciliation change. Consistent with **ADR 0039** (exposure) and **ADR 0040** (returns): all three are reference/forecast layers sitting off the truth, never frozen.
- **Builds on** operations and `projectFire` (#421); the **exposure-drift** what-if (projecting composition forward under the plan) is deferred and **gated on #539**.
- Sliced in PRD #553: **S0** (#554) throwaway prototype; **S1** (#555) model + storage + derived capacity; **S2** (#556) reconciliation; **S3** (#557) monthly allocation view; **S4** (#558) what-if + growth toggle; **S5** (#559) MCP; **tie-in** (#560) exposure-drift what-if, gated on #539.
