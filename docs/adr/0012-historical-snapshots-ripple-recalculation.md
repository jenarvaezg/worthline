# Backdated facts generate historical snapshots and ripple-recalculate existing ones

Snapshots are captured automatically, at most one per scope per day (ADR 0005),
and freeze the valued portfolio behind the figures (ADR 0008). Until now the
only way to have history was to accumulate daily captures: a user starting
fresh — or importing years of past operations — saw an evolution chart that
began today.

We decided that declaring a **dated fact about the past** — a backdated
investment **operation**, a **valuation anchor**, a **balance anchor**, an
**amortization plan** — generates the snapshot for that date and re-derives
the existing snapshots it affects. PRDs #107 (operations), #108 (housing),
#109 (debts) build on this decision.

## New information vs edits to the present

"Frozen means frozen" stands, sharpened: it protects history from **edits to
the present**. Renaming, revaluing, trashing, or hard-deleting a holding never
alters what a past snapshot captured. A backdated fact is neither of those —
it is new information about what the portfolio actually was on a past date.
Re-deriving the affected snapshots makes history _more_ true, not less frozen.

## Ripple recalculation

- Declaring a fact dated D generates or overwrites the snapshot at D (the
  latest-wins-per-day policy of ADR 0005 applies unchanged) and recalculates
  existing snapshots dated **after** D.
- Modifying or deleting a fact dated D recalculates existing snapshots dated
  **D or after** — the snapshot at D itself was derived from the fact that
  just changed.
- Only snapshots that already exist are recalculated. No intermediate dates
  are backfilled.
- Recalculation re-folds operations and anchors up to each snapshot's date.
  Manual values keep their last-known-value basis. For investments, the unit
  price is the one that snapshot already captured for that asset — the best
  known price of that date; only an asset absent from the snapshot falls back
  to the last known price at or before the date.
- Facts dated today or in the future never trigger historical generation:
  today is covered by the daily capture, and the future is not history.

## Generation density

Each source generates snapshots only at its own event dates: operations at
operation dates, valuation and balance anchors at anchor dates. Amortization
plans are the deliberate exception: a plan declares a monthly schedule, so it
generates one snapshot per past payment date. There is no backfill beyond
declared or schedule-derived event dates.

**The monthly floor of reconstructed history.** Event dates alone make the
resolution of pre-signup history a measure of how often the user *operated*,
not of how much time passed: a month with four trades gets four points, a quiet
month none, and the chart draws a straight line across it — beside a housing
curve that is monthly by construction. So the historical **gap-fill / backfill**
(`gapFillHistoricalSnapshots`, and the one-shot `backfillHistoricalSnapshots`)
also guarantees the **1st of every month in which some investment held a
position**, on the same monthly grid as the price backfill (ADR 0033).

This is a floor, not a replacement: the generated dates are the **union** of the
event dates and those month-starts, so an operated month keeps its density. It
is still not "backfill every date between events" — nothing fills the days
*between* the 1st and an operation, no extra month-end snapshot is invented
(`is_monthly_close` stays derived, ADR 0005), and the per-fact ripple and the
daily capture are unchanged. A month whose 1st has no position (before the first
purchase, or after everything was sold) yields nothing. No price is fetched: an
unpriced month is generated at cost basis and ADR 0033's backfill remains the
single writer of historical `unit_price`.

## Import

An export carries the frozen snapshot history (ADR 0010). Import restores
those snapshots exactly as exported and **never recalculates them**: they were
captured with true contemporaneous data, and the audit trail behind manual
values is deliberately not exported, so a post-import re-derivation would
replace truth with approximation. Historical generation during import only
fills gaps — event dates with no snapshot in the file — folding the imported
operations once, in one pass, with a single ripple at the end.

## Considered options

- **Strict frozen (forbid backdating)** — rejected: kills the core use case,
  reconstructing history when starting fresh or importing past operations.
- **Mark generated snapshots** (`is_historical` flag) — rejected: a snapshot
  generated for a past date is an ordinary snapshot; one model, no special
  kinds to reason about downstream.
- **Recalculate imported snapshots on import** — rejected: degrades real
  captured history into approximations (see Import above).
- **Backfill every date between events** — rejected: volume without
  information; the evolution chart already interpolates between points. The
  monthly floor above is the bounded amendment: one guaranteed point per month
  with a position, not one per day.
- **A weekly floor** — rejected: four times the volume for a resolution no
  other curve in the app has.
