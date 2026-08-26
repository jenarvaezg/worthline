# A historical ripple is one band and a rewrite per family

- Status: accepted
- Date: 2026-08-26
- Issue: #1590

## Context

ADR 0012 decided WHAT a historical ripple is: a dated fact that lands in the past
regenerates the snapshot at its own date and recalculates every existing snapshot
it affects. ADR 0008 added the frozen holding rows a recalculation rewrites, ADR
0019 the two-date debt curve, ADR 0020 the one-transaction persist+ripple.

The mechanism was written six times. `ripple-engine.ts` held one function per
family — investment operations (twice: one operation, and a batch), a mixed
statement import, housing valuations, debt curves, ownership splits — and each
one carried the same 40-line walk:

```
for each scope:
  existing = readSnapshots(scope)
  for each event date: generate the missing past snapshot
  frozen = one batched readSnapshotHoldings(scope, from)
  for each existing snapshot ≥ floor:
     maybe prune an orphan; skip a legacy capture; rewrite one row; save or drop
```

Only the last line differed. Everything else — the scope loop, the growing
`existingDates` set that keeps a repeated date from being built twice (#1435), the
batched frozen read and its ordering guarantee (#205/#206/#1533), the ADR-0008
legacy-capture skip, the save-or-drop — was copy, and the copies had drifted:
`#205` batched the operation read, `#206` the debt one, and `#1533` had to come
back a year later for valuation and ownership because those two copies were still
querying once per snapshot.

The debt family paid for it twice. Because its dates come from the live curve, it
had grown a `kind` union — `amortizable-plan`, `amortizable-revision`, `anchor`,
`amortizable-rebaseline`, `amortizable-repayment` — that mixed two questions in
one word: which dates the fact mints, and which date the recalculation starts
from. Once a repayment needed those to be DIFFERENT dates (#1291/#1042) the union
grew a member carrying both, and every new debt fact meant a new arm in a
`switch` inside the engine, far from the call site that knew the answer.

## Decision

The walk is **one primitive**, `rippleBand`. A family is a thin command that
supplies four things and no loop: the identities it already read, the dates its
fact mints, the floor it recalculates from, and how one snapshot's rows are
rewritten.

- **A rewrite is pure, synchronous, and has three answers.** It returns a
  snapshot (save it, replacing the frozen rows), `null` (no holdings remain, drop
  it), or `undefined` (leave it exactly as it is). The third is what lets a
  family whose affected set is not a date range — an ownership split re-weights
  only the dates whose household snapshot carries the edited holding
  (#172/#187/#212) — ride the same walk as the ones that are. Every read a
  rewrite needs is made once by the family BEFORE the band starts, never per
  snapshot; that is what keeps it synchronous.
- **A floor of `null` means every date.** The ownership re-weight has no date
  axis, so it hands the band no `generate` block and no floor, and decides date
  by date inside its rewrite.
- **The dates travel as `{ eventDates, recalcFrom }`, never as a kind.** The
  debt family's call sites state both outright. The two shapes that can only be
  derived from the live curve — the whole cuota series, a re-baseline chain —
  travel as named resolvers (`debtPlanBand`, `debtRebaselineChainBand`) that the
  band evaluates against the curve it holds. Adding a debt fact adds a call site,
  not an arm in a union.
- **The prune is a question, not band mechanics.** "Does any dated fact still
  make this date an event date?" is a query over every fact table, so it lives in
  its own module (`orphan-backfill-prune.ts`) and the band only decides WHERE to
  ask it.
- **Deps are a thunk, not a value.** The whole-portfolio read exists to MINT a
  snapshot and for nothing else, so the band awaits it at most once and only
  when a date actually needs building. The commonest write in the app mints
  nothing — an operation dated today is covered by the daily capture — and now
  pays nothing for it.
- **One band, one transaction.** Generation, prune and rewrites commit or roll
  back together. A family that must refuse its own result wraps the call and
  throws there; `ctx.transaction` flattens, so the rollback still covers every
  snapshot the band saved (the debt band's "generated, but not one snapshot
  carries the debt", #1438).

Behavior is untouched: the same dates are generated, the same snapshots
recalculated and dropped, the same orphans pruned, in the same order, with the
same logs and the same throw.

The band is split from the families by file: `ripple-band.ts` is the walk,
`orphan-backfill-prune.ts` the question, `ripple-engine.ts` the investment,
mixed-import, housing and ownership commands, and `debt-band.ts` the debt one —
whose dates come off the live curve, which is what gives it its two resolvers.

## Consequences

- The single-operation ripple is gone. It was the one-asset case of the batched
  one, which now serves all three of its call sites.
- A performance fix to the walk — a batching change, a read-shape bound — is made
  once and every family has it. The #1533 repeat cannot happen again.
- The next family of dated facts writes a rewrite, not a loop. If it cannot
  express itself as `{ identities, eventDates, recalcFrom, rewrite }`, that is
  the signal to question the fact's shape, not to clone the band.
- A comment saying "mirrors X" in a ripple is a defect report: it means a clone
  came back.
- The coin-acquisition ripple (ADR 0017) rides the band too, which is what
  retired its per-snapshot frozen read. Its rewrite is additive, so it maps a
  null recalculation to "leave it" rather than "drop it" — the band's third
  answer earning its keep for a second family.
- The Binance monthly backfill (ADR 0021) deliberately stays outside. It walks a
  union of month-ends and existing dates rather than the existing snapshots, and
  it mints empty shells on purpose; bending the band to fit it would make the
  band a framework, which is the thing this decision is not.
- The band is not a framework. It has one exported function, two optional hooks
  with one consumer each, and no registry, plugin or lifecycle. The families are
  commands, not implementations of an interface.
