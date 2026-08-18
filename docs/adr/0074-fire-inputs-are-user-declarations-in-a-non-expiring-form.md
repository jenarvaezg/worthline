# The FIRE inputs are the user's declarations, stored in a form that cannot expire; what is measured or derived is a lens

## Context

The FIRE projection takes a handful of inputs: monthly spending, the safe withdrawal
rate, the reference age, the monthly savings capacity. Two of them had grown a second
source, and both broke the same way.

**The age** (#1415, ADR 0073) was typed into settings and stored as a number. Jorge
typed 62; the year he turned 63 the app still read 62, and every age the projection
printed drifted one year young — always in the flattering direction, always growing.

**The savings capacity** (#1416) was overridden by the contribution plan: whenever the
plan had rows, `resolveMonthlySavingsCapacityForFire` summed their monthly equivalents
and returned `source: "plan_derived"`, keeping the declared scalar only as a fallback
for an empty plan (ADR 0041). Jorge had declared **1.500 €/mes** in settings. His plan
had one row — 100 €/mes to a pension plan. The projection ran on the 100:

| Contribution                      | Optimistic | Base   | Pessimistic |
| --------------------------------- | ---------- | ------ | ----------- |
| 1.500 €/mes (what he declared)    | 67         | 68     | 70          |
| 100 €/mes (what was projected)    | 70         | **73** | **80**      |

Five years of FIRE date, with nothing on screen saying the app had stopped reading the
field he filled in. And the guard asked whether the plan was *empty*, not whether it
was *active*: his only row ended 2026-11-30, so on 1 December the capacity would have
become **0 €/mes** without him touching anything.

The deeper defect is a category error, not a missing warning. A plan row is a planned
addition **to one named destination** — a subset of what somebody saves. Substituting
the sum of those rows for a declared total under-estimates by construction, and no
banner fixes a figure that is measuring the wrong thing.

The two failures share a shape: **an input acquired a second source that nobody
revalidates.** A typed age is a fact with an expiry date that nothing enforces. A
plan-derived capacity is a partial standing in for a total.

## Decision

**The inputs of the FIRE calculation are the user's declarations, and they are stored
in a form that cannot expire. Anything measured or derived elsewhere is a lens or a
warning — never an input that overwrites the declaration.**

1. **In FIRE live final values.** It is a deliberate simplification: a projection
   over decades does not get more truthful by being assembled from monthly detail, and
   the detail brings its own drift. Cashflow richness belongs to the returns and
   payouts surfaces, which is where it already lives (ADR 0040, ADR 0054).

2. **A declaration must be stored in a non-expiring form, or derived from one.** This
   is what reconciles ADR 0073 with this ADR, which look opposite at first glance: the
   age *has* a non-expiring form (a birth date), so it is derived from it and the typed
   field is gone. The savings capacity has none — nothing in the data says what
   somebody *intends* to save next year — so it stays a declared scalar and nothing
   overwrites it.

3. **One door per input, and it reads one field.** `monthlySavingsCapacityForFire(config)`
   is the only way the projection learns a contribution — dashboard, /objetivos,
   fireLevels, goal-delay and the agent view all come through it, so none of them can be
   the one that read something else. `resolveMonthlySavingsCapacityForFire` and the
   `plan_derived` source are removed outright, not left behind with one live arm.

4. **What is measured becomes a check, not an input.** The app *can* measure savings
   from the operations ledger (`suggestMonthlySavingsCapacity`, #425). That figure
   stays what it is: the default the form offers, and the basis of the coherence
   warning in #1449 — declared against measured, plus a veto on achievement badges
   while measured savings are negative. Crossing the two is how a wrong declaration
   gets caught; overwriting one with the other is how a right one gets lost.

5. **A cut that would silence an input seeds it first, out loud — and the seed
   preserves, never invents.** Scopes whose projected capacity came from the plan and
   never declared a scalar are seeded once (enqueued by schema v56) with *the plan's
   own active total*: bounded by the plan, and identical to what the retired
   derivation returned. The written figure carries
   `monthlySavingsCapacitySeededFromPlan`, and /ajustes says "we put this here, check
   it". A number the user never typed must never appear as if he had — which is also
   why nothing is written for the shapes that already project 0 today (a plan whose
   rows have all lapsed, or an active units row with no price: both summed to 0 under
   the old resolver too). Deriving a seed from *measured* savings was considered and
   dropped: `suggestMonthlySavingsCapacity` divides net invested by the months its
   operations span, so one 200.000 € lump sum in a single month reads as
   200.000 €/mes. Writing that into a config — once, irreversibly, in the flattering
   direction — is the failure this ADR exists to stop.

6. **A one-shot migration is gated on persisted state, not on a returned flag.** The
   seed needs the domain (cadence math), and the migration ladder is a leaf with no
   `@worthline/domain` dependency, so the work happens in the store on open. The
   ladder therefore *enqueues* it as a row (`fire.capacity_seed.v56 = pending`) rather
   than signalling it in `MigrateResult`: the ladder also runs from
   `runBootstrapHealthcheck`, which discards its result, and the version bump commits
   before the work — so a boolean can be consumed by a process that never seeds, or
   lost to an error, leaving the workspace at 0 with no marker and no note. The row
   survives both, and is flipped to its completion stamp inside the same transaction
   as the write, so a save racing the seed cannot lose the figure the user just typed.

## Alternatives considered

- **Warn that the plan is overriding the scalar (rejected — the original plan for
  #1416).** It signposts a figure that is measuring the wrong magnitude. The user's
  only useful response to the warning would be "then don't do that".
- **Take the maximum of declared and plan-derived (rejected).** Silently generous, and
  still a subset competing with a total; the FIRE date would move when a plan row was
  added, for no reason the user could name.
- **Keep the derivation but only for scopes with no declared scalar (rejected).** That
  is exactly the seed's job, done once and visibly, rather than a permanent second code
  path that only some workspaces travel.
- **Derive the capacity from measured savings on every read (rejected).** Savings
  measured from operations is *past* behavior and it swings hard month to month (Jorge:
  119 / 60 / 150 / 150 €). A projection input that changes when you record a purchase
  is not a plan; it is a mood. It is the right basis for a *warning*, which is #1449.
- **Delete the contribution plan's role entirely (rejected).** The plan keeps every
  other use it has: reconciliation, the monthly allocation view, the exposure-drift and
  contribution what-ifs, and the #1427 cupo. What it loses is being an input to the
  FIRE projection.

## Consequences

- `resolveMonthlySavingsCapacityForFire`, `MonthlySavingsCapacityResolution`,
  `derivedMonthlySavingsCapacity` and `activeUnitContributionsMissingPrices` are gone.
  What survives is `plannedMonthlyContributionsMinor` — the plan's own monthly total,
  named as a plan figure — whose only caller is the v56 seed.
- `prepareDashboardState`, `fireLevels` and `goalFireDelay` no longer take a
  contribution plan or unit prices: the type system now enforces what this ADR says.
  `loadDashboard` drops one query from the home GET as a side effect.
- `get_contribution_plan` no longer reports a `monthlySavingsCapacity`. The plan's own
  monthly figure is `monthlyAllocation.totalPlanned`; the capacity the projection
  contributes is `get_fire_projection.monthlySavingsCapacity`. One number per question,
  so the assistant cannot quote a subset as the total.
- ADR 0041's "`monthlySavingsCapacity` becomes derived" is superseded. The rest of that
  ADR — the plan as a forecast layer reconciled by hand, never entering net worth or
  snapshots — stands unchanged.
- The seeded marker is cleared by the first save of the FIRE form (a side effect of
  `saveFireConfig` replacing the scope object — pinned by a test, because the one
  carve-out that function has, the legacy `currentAge`, is exactly the shape that
  would make the band permanent), and it survives a workspace export/import so the
  "check it" note is not lost in a transfer.
- `importWorkspace` writes a transfer document's `fireConfig` verbatim into a DB that
  is already past v56, so a document produced on the old build (capacity unset + a
  plan with rows) lands with no capacity and no marker: that workspace projects 0
  where it used to project the plan's total. Deliberately not chased — after this
  change an unset capacity is an empty field in the form that drives the projection,
  with the measured suggestion beside it, not a hidden state.
- Not covered here: whether the FIRE configuration should live in /objetivos rather
  than /ajustes (#1450), and the coherence warning + achievement veto this cut makes
  mandatory (#1449). This ADR is what makes both of them well-defined.
