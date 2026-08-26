# A ripple row is one skeleton and a valuation per lane

- Status: accepted
- Date: 2026-08-26
- Issue: #1601

## Context

[ADR 0089](0089-a-historical-ripple-is-one-band-and-a-rewrite-per-family.md)
unified the I/O of a historical ripple: one `rippleBand` walks the scopes,
generates the missing dates and saves or drops each snapshot, and a family
supplies only the rewrite. It left open what a rewrite DOES.

The rewrite was written six times. `historical-snapshot.ts` held one
`recalculateSnapshotFor*` per trigger — an investment's operations (ADR 0012), a
housing curve (PRD #108), a debt curve (PRD #109), an ownership split (#172), a
coin acquisition (ADR 0017), a connected market value (ADR 0021) — and each one
carried the same skeleton:

```
open the frozen rows: set the holding's own row aside, keep every other verbatim
value the holding on the snapshot's date          ← the ONLY line that differed
allocate that global value into the snapshot's scope
freeze the row's identity (frozen row → contemporaneous capture → live, #242)
push the row with its label, kind and three classification fields
assemble: derive the five figures from the new row set and reconcile (#181, ADR 0008)
```

#242 had already extracted the identity seam and #181 the assemble seam, and
#1027 had folded the four modules the ripples were briefly split into back into
one file. What was left was the skeleton itself — and the copies had drifted:

- The rung rule for a debt row was taught to the debt lane and not to the
  ownership one. #1436 decided that a debt securing HOUSING freezes the `housing`
  rung even where its home carries no row that date, because the rung follows the
  asset's identity, not its presence. The ownership lane, which mints a debt row
  for the member who GAINS a stake, kept the pre-#1436 branch: `cash`.
- The debt lane resolved its row's tier and `securesHousing` with its own
  `existingRow ? … : …` ternaries instead of the identity seam, so it was the one
  lane that could not recover a contemporaneous frozen capture at all.
- "Does this frozen row exist at all?" — the question that separates a value lane
  (a row only where the scope holds a stake) from an additive one (keep the
  existing row even at a zero stake) — was six independent `if`s.

## Decision

The skeleton is **one primitive**, `rippleHoldingRow`. A lane supplies the
holding it rewrites and ONE function: `revalue`, what that holding is worth on
that date.

- **A valuation has three answers in one shape.** `revalue` returns
  `{ valueMinor, live, detail? }` or `null`. `valueMinor` is already scope-
  weighted (the primitive hands the lane an `allocate` closure, so no lane
  re-reads the scope's members or the holding's split). `live` is the LIVE
  classification, and it is only ever the last resort: the primitive still runs
  it through `resolveFrozenIdentity`, so this snapshot's own frozen row wins,
  then the contemporaneous capture from another snapshot, then live (#242).
  `detail` carries the fields only some lanes have — an investment's units and
  unit price, a collection's frozen position breakdown (ADR 0035).
- **`null` means no row, and the lane decides what that means.** The existence
  rule stays in the lane on purpose, because it genuinely differs: a value lane
  drops the row when the scope holds no stake, while the additive (ADR 0017) and
  set (ADR 0021) lanes keep an existing row at a zero stake so a re-weight to
  zero never silently deletes it. What is shared is that the primitive then
  assembles the snapshot WITHOUT the row — never a second `assembleRippleSnapshot`
  call site per lane.
- **A debt row's rung and `securesHousing` live once**, in
  `liveLiabilityIdentity`: the housing rung when the debt secures a housing asset
  (#1436), else its asset's frozen rung from the surviving rows, else `cash`;
  null for an unassociated debt; never a housing ASSET. Both lanes that mint a
  debt row now ask it.

Behavior is untouched everywhere the copies agreed. Where they had drifted, the
answer is now #1436's: a mortgage born in an OWNERSHIP ripple freezes the
`housing` rung, not `cash`. It never moved a figure — `securesHousing` wins in
`deriveRowAxes` — but it drew a mortgage on the cash rung of the liquidity
ladder for those dates, and an existing row's rung is preserved by every later
ripple (ADR 0008), so the wrong answer was permanent.

## Consequences

- Adding a trigger is writing a `revalue`. If a new dated fact cannot express
  itself as "what is this holding worth on this date", that is the signal to
  question the fact, not to clone the skeleton.
- A change to how a rippled row is built — a new frozen field, a change to the
  identity precedence, a change to reconciliation — is one edit, not six.
- The lanes keep their own exported functions and their own typed inputs. The
  primitive has no registry, no dispatch and no lifecycle: it is a function that
  takes a function. Frozen history is not `agent-lite`.
- The debt lane now passes through the identity seam like its siblings. It still
  supplies no captures, so its behaviour is unchanged today — but the day a debt
  needs contemporaneous recovery, it is a parameter, not a rewrite.
- The CAPTURE path keeps its own answer, and that is deliberate. It resolves a
  debt's rung against the LIVE asset set (`classificationAssets`), where the home
  it secures is always present, so it needs no housing short-circuit; the ripple
  has only frozen rows. Two routes, one answer — and what pins them together is
  the parity test that captures a portfolio and makes every ripple path reproduce
  the same row set for the date (#181), not a shared function. Folding them would
  mean handing the capture a set it does not need.
- The coin lane stays long. Its `revalue` is ~70 lines because valuing that row
  IS the per-position allocation, the already-frozen `positionKey` skip and the
  children-vs-aggregate increment decision (ADR 0035 vs ADR 0017). That is
  valuation, not skeleton: the primitive was never going to shorten it.
- ADR 0089 owns the walk, this owns the row. Between them a ripple has no copied
  loop and no copied skeleton left.
