# A FIRE projection is one growth step and a target per view

## Context

Every FIRE trajectory worthline draws — the home chart, the /objetivos level rail, the
Coast arrival date, the goal-delay probes, the assistant's `get_fire_projection` and the
contribution what-if — has gone through `projectFireFromContext` since #1122. One door,
so the rate, the FIRE number and the reference age could only come from the
`FireContext` (#1026) and could never drift apart from coast and levels.

The door was one. The **engine** underneath was two.

`projectFire` compounded a single scalar year by year — `capital = capital × (1 + r) +
annual` — while `projectFireWithContributionPlan` (ADR 0041) ran its own loop over a map
of per-holding buckets, growing each at its own rate and adding the plan's occurrences
bucketed by projection year. Two loops that have to produce the same figure agree only
for as long as somebody keeps them in step, and the only equivalence the suite pinned
was the easiest case there is: a constant monthly contribution at a uniform rate. That
case is precisely the one in which the two loops cannot disagree.

The door had grown a second problem. Its input type carried the scalar fields *and* the
plan fields at once, and silently dropped whichever half the mode did not use:
`monthlyContributionMinor` was never read in plan mode, and `projectFireFamilyFromContext`
— the two-view growth the level rail needs (#1537) — accepted `plan` and
`growthAssumption` only to ignore them whole. A caller could believe it was measuring
the contribution what-if and be measuring the scalar. Nothing in the types said
otherwise, and no figure on screen looked wrong.

And the plan engine broke the domain's own clock seam (ADR 0024): a plan buckets its
contributions by calendar year, so it needs today's date — and when the caller did not
pass one, the door read `new Date()`. A pure recalculation function reaching for the
wall clock is the exact thing ADR 0024 exists to prevent: the page's "today" and the
projection's "today" could differ, and nothing would say so.

## Decision

**There is one growth step. A mode is which buckets it steps and which targets it
times; a view is which target it reads.**

1. **One step, in `fire-stepper.ts`.** `runFireGrowth` grows a map of buckets by each
   bucket's annual rate, adds that year's contributions, records the point, and repeats
   until the highest target is reached or the horizon runs out. Grow first, contribute
   second — the contribution enters at year end and does not compound that year — is the
   contract, and it is now written once.

2. **The three modes are the same step with different inputs.** Scalar is one aggregate
   bucket at a uniform rate with the same annual contribution every year. Plan is one
   bucket per holding, each at its own rate (#547), over the plan's stream bucketed by
   projection year. The family is the scalar with **two named targets** — the regular
   FIRE number and the Fat horizon — timed on the *same* run, so the chart and the rail
   interpolate on one trajectory rather than two.

3. **Targets are named, not positional.** `runFireGrowth` takes
   `{ fire, horizon }` and returns `yearsToTarget` keyed the same way; a view names the
   target it reads. There is no index to line up.

4. **Three doors, each with the type of its own mode.** `projectFireFromContext`
   (scalar), `projectFireFamilyFromContext` (scalar + horizon, package-internal) and
   `projectFirePlanFromContext` (the what-if). No door accepts a field it will not read.
   They still share the context defaults through one helper, so no door can invent its
   own default for the starting balance, the rate, the FIRE number or the age.

5. **The clock is an input, never a fallback.** `todayISO` is **required** on the plan
   door, because the plan's growth depends on the calendar. `calculateFireForScope` takes
   its declared rents and their measuring day as one inseparable value
   (`rents: { schedules, todayISO }`), and `prepareDashboardState` requires `today`.
   `systemClock` (ADR 0024) remains the only thing in `domain` that reads a wall clock.

## Consequences

- **No figure moves.** The scalar path is byte-identical: one bucket stepped by
  `amount × (1 + r)` then `+ contribution` is the same float arithmetic, in the same
  order, as the scalar loop it replaces, and the totals contributed now come from the
  cumulative series at the year the view reached instead of a multiplication that agreed
  with it. /objetivos, the home glance and the agent view publish exactly what they
  published.
- **Equivalence is structural, not coincidental.** The scalar and the plan cannot drift,
  because there is nothing left to keep in step. The suite still pins equivalence — and
  now beyond the uniform case: a plan whose contribution changes from one year to the
  next tracks the scalar until it changes, and follows the same step afterwards.
- **A caller can no longer be silently wrong about what it measured.** Handing `plan` to
  the family or to the scalar door is a type error, and omitting `todayISO` from the plan
  door is a type error. Both are pinned with `@ts-expect-error` so the gate is the
  typechecker, not a review.
- **Callers must hand in the day.** Every production caller already did; what changed is
  that forgetting is now impossible rather than invisible.
- **A third mode would be a third set of inputs, not a third loop.** That is the point.
