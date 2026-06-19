# Modeled holdings step between events; daily interpolation is a per-holding opt-in

A holding whose value is **derived from a model** rather than a market price —
an **amortizable** debt's French schedule, a **revolving** debt's anchors, a
real-estate asset's **appreciation rate** — had its value computed by **linear
interpolation by calendar day** between its event points. The outstanding
mortgage balance crept down a little every day between cuotas; a house drifted
up a fraction each day toward the next appraisal; a revolving balance slid
linearly between two declared anchors. None of that daily movement is observed:
you owe the same principal until the next payment lands, the bank reprices
nothing on a Tuesday, and a balance you declared in March says nothing about
April 3rd. The daily curve was **invented precision** — a slope drawn through
points that only ever move in steps.

We decided that a modeled holding's value is a **right-continuous step**: it
changes only on the holding's own **event dates** and is flat between them. This
is the default. Daily interpolation does not disappear — it becomes a
**per-holding opt-in** (`valuation cadence = interpolated`) for the user who
prefers a smooth curve on a specific holding. Market-priced holdings (the
`derived` and `stored` methods) are unaffected: their daily movement is a real
observed price, not interpolation, so the cadence axis does not apply to them.
`informal` debts were already a step function (ADR 0014 / PRD #109) — this makes
the rest of the modeled holdings consistent with that, instead of the other way
round.

## What an event date is, per valuation method

The step holds the value from the most recent past event up to (not including)
the next. "Event" is method-specific:

- **`amortized`** (amortizable debt — a mortgage and a conventional loan alike,
  ADR 0019): the **payment-boundary dates**. The outstanding balance from cuota
  _m_ until cuota _m+1_ is the balance after the _m_-th payment, with **no
  intra-month proration**. Flat at the initial capital before the first payment
  (the disbursement→first-payment stub, ADR 0019), zero on/after the final
  payment. The cuota day is the day-of-month of the first-payment date.
- **`anchored`-revolving** (revolving debt): the **balance-anchor dates**. The
  balance is the most recent anchor with date ≤ target, flat before the first.
  This makes revolving behave like **informal** between anchors; the two now
  differ only in intent, not in curve.
- **`appreciating`** (real-estate drift): the value is **recomputed on the first
  of each month and held flat through the month**. Declared anchors still take
  effect on their exact date — a **market appraisal** or an **improvement** is a
  step on the day it is declared, and the next month-start resyncs the drift from
  there. There is no natural sub-monthly event for rate- or appraisal-driven
  drift, so the 1st of the month is the chosen sampling anchor.

## The cadence is a per-holding attribute

A holding carries a **valuation cadence**: `step` (the default) or
`interpolated`. It is orthogonal to the **valuation method** (ADR 0014) and lives
beside it on the holding (on `assets` and on `liabilities`). It is only
meaningful for the modeled methods above; on `stored` and `derived` holdings it
is ignored, and on `informal` debts `step` is the only behaviour (their defining
"no interpolation, ever" stands). Set in the holding's **advanced** editing
surface; absent (`null`) means `step`.

`interpolated` restores the prior behaviour for that one holding: linear
interpolation by calendar day between the same event points (and, for
`appreciating`, continuous daily compounding of the rate). It changes how the
value is read between events — never which events exist.

## Default, migration, and the ripple

The default is `step` for **every** holding, existing ones included — not just
those created after this decision. `null` is read as `step`, so no value backfill
is needed; the column only ever stores `interpolated` when a user opts a holding
out. Existing modeled holdings are **re-rippled** (ADR 0012): the snapshots on
their event dates are unchanged (an event-date snapshot already equalled the step
value — the interpolation fraction there was zero), so the only snapshots that
move are the **daily captures** (ADR 0005) that happened to fall _between_ events,
which flip from an interpolated value to the flat last-event value. Net worth on
any event date, and today's headline whenever today is an event date, are
unchanged. Schema change follows the forward-migration approach (ADR 0002).

## Relationship to snapshots and the chart

ADR 0012 rejected backfilling a snapshot for every date between events, partly
because "the evolution chart already interpolates between points". That stands
for **generation density** — we still create no intermediate snapshots. What this
ADR changes is the **value** each `valueAt(date)` call returns between events:
stepped, not interpolated. Where daily captures exist, the chart then draws a
flat run and a drop — the step is visible for free. Where only event-date
snapshots exist, the SVG line (ADR 0009) still connects two dots with a sloped
segment; rendering those segments as steps for modeled holdings is a presentation
refinement left to the chart layer, not part of this decision.

## Considered options

- **One global toggle instead of per-holding** — rejected: the right cadence is a
  property of the instrument (a mortgage steps; a user may legitimately want a
  smooth house), not a workspace-wide preference. A single switch forces one
  answer on holdings that disagree.
- **Keep interpolation the default, make `step` the opt-in** — rejected: it keeps
  the invented precision as the thing every new holding gets, and contradicts
  `informal` already being a step. The honest model should be the default; the
  smooth curve is the special request.
- **Backfill existing holdings to `interpolated` to preserve their curves** —
  rejected: it would split the default between old and new holdings and leave the
  current user staring at the same fake daily drift until they flip every toggle.
  A one-time re-ripple to the step value is the point, not a regression to avoid.
- **Step housing on its appraisal dates only, no monthly sampling** — rejected:
  between two appraisals (or under a bare rate with none) there is no event for
  months, so the value would sit frozen for a year and lurch at the next
  appraisal. Sampling the drift monthly keeps it moving at the cadence a homeowner
  actually re-estimates, without pretending to daily resolution.

## Consequences

- A modeled holding's "today" value is the value at its last event: a mortgage
  shows the balance from the last cuota, a house its month-start value, a
  revolving debt its last declared balance. No more sub-event drift in the cards.
- `revolving` and `informal` now share a curve shape (step on anchors); they
  remain distinct **debt models** by intent and by what a future interpolation
  opt-in would mean.
- The affected CONTEXT.md glossary entries — **Valuation anchor**, **Market
  appraisal**, **Appreciation rate**, **Debt model**, **Balance anchor** — are
  updated to describe the step as the default and interpolation as the opt-in, and
  a new **Valuation cadence** term is added.
- The cadence rides the export/import contract (ADR 0010 / 0015) like any other
  part of a holding's model, so a smooth-curve opt-in survives a round-trip.
