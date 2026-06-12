# Snapshots capture the valued portfolio, holding by holding

Snapshots stored five headline aggregates (net worth, liquid net worth, housing
equity, gross assets, debts), which was enough for the evolution chart but made any
drilldown — how the liquid slice splits into cash vs market over time, which of two
properties revalued more — unanswerable: per-tier and per-holding composition is not
reconstructible after the fact. We decided each snapshot also captures every holding
behind its figures: the holding's stable id, its label and liquidity tier copied at
capture time, its scope-weighted value, and — for investments — units and unit price
as decimal strings.

We considered capturing only per-tier aggregates (10 figures, enough for the
tier-level drilldown that prompted this) but chose per-holding capture: the data
volume is irrelevant in a local SQLite app, holding-level history is the only level
that answers "how much did _this_ asset hold at _that_ time", and every day not
captured is history lost forever — arriving early beats arriving perfect.

## Consequences

- Label and tier are denormalized on purpose: a snapshot is frozen, so later edits,
  renames, deletions, or tier changes of a holding must never alter what a past
  snapshot captured. No live foreign keys into holdings.
- Per-tier aggregates are always derived from the holding rows, never stored — one
  source of truth. At capture time an invariant must hold: the holding rows sum
  exactly to the headline gross assets and debts, or the capture fails loudly.
- History before this change has no holding rows and cannot be backfilled; drilldown
  charts simply start later than the headline evolution chart.
- A holding that leaves the portfolio (sold, written off) keeps its captured history
  and stays visible in drilldowns — truncated, marked as no longer held.
- Capturing units and unit price lets a future chart split an investment's growth
  into contribution vs appreciation; the exact price used that day (with its cache
  and manual fallbacks) is otherwise unrecoverable.
