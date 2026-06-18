# Update and delete of a dated debt fact read the old date behind the store seam

## Context

ADR 0020 made declaring, modifying, or deleting a **dated fact about the past** one
atomic persist-and-ripple operation behind a single store method. The _add_ paths
landed clean: `addBalanceAnchorAndRipple`, `addInterestRateRevisionAndRipple`, and
`addEarlyRepaymentAndRipple` derive the **ripple from-date** from the fact's own
date inside the transaction, and the caller passes only the parsed command.

The _update_ and _delete_ paths did not. Six methods still demand the **old date**
from the caller — `previousAnchorDate`, `previousRevisionDate`,
`previousRepaymentDate` — so the action layer reads the row first to feed it
(`packages/db/src/index.ts:462`, `473`, `495`, `506`, `528`, `538`). Each edit/delete
action does a full list-and-find before the write:
`store.liabilities.readBalanceAnchors(id).find((a) => a.id === anchorId)`
(`apps/web/app/patrimonio/actions.ts:1528-1530`, `1594-1596`), and the same shape for
revisions (`1153-1155`, `1220-1222`) and repayments. The previous date is then
threaded back into the seam, where it computes the from-date —
`min(previousAnchorDate, newDate)` for an edit (`index.ts:1425-1427`,
`1290-1291`, `1357-1359`) and the row's own date for a delete (`index.ts:1452`,
`1316`, `1386`).

That read is exactly the store's job, and the store **already does it**. Every
internal `update*`/`delete*` function selects the row by id inside the transaction
before writing — it just selects the foreign key and discards the date
(`liability-store.ts:817-821`, `844-849` for anchors; `549-553`, `586-590` for
revisions; `668-672`, `704-708` for repayments). The old date is one column away,
read at the only moment that is race-free: inside the transaction, after acquiring
the write. Forcing the caller to read it first leaks a store internal, duplicates a
query the store repeats, and opens a window where the caller's read and the store's
write disagree. This decision removes the `previous*Date` (and the now-redundant
`liabilityId`) opts so the seam reads the old date itself.

## Decision

Update and delete of a dated debt fact read the **old date inside the
transaction**, derive the from-date there, persist, and ripple — atomically. The
caller passes only the id, the patch (for updates), and the `today` test seam. No
`previous*Date` and no `liabilityId` cross the seam; the store reads both from the
row it already selects by id.

**Balance anchor**

```ts
// before
updateBalanceAnchorAndRipple(anchorId, input,
  { liabilityId, previousAnchorDate, today? }): number
deleteBalanceAnchorAndRipple(anchorId,
  { liabilityId, previousAnchorDate, today? }): number
// after
updateBalanceAnchorAndRipple(anchorId, input, opts?: { today?: string }): number
deleteBalanceAnchorAndRipple(anchorId, opts?: { today?: string }): number
```

**Interest-rate revision**

```ts
// before
updateInterestRateRevisionAndRipple(revisionId, input,
  { liabilityId, previousRevisionDate, today? }): number
deleteInterestRateRevisionAndRipple(revisionId,
  { liabilityId, previousRevisionDate, today? }): number
// after
updateInterestRateRevisionAndRipple(revisionId, input, opts?: { today?: string }): number
deleteInterestRateRevisionAndRipple(revisionId, opts?: { today?: string }): number
```

**Early repayment**

```ts
// before
updateEarlyRepaymentAndRipple(repaymentId, input,
  { liabilityId, previousRepaymentDate, today? }): number
deleteEarlyRepaymentAndRipple(repaymentId,
  { liabilityId, previousRepaymentDate, today? }): number
// after
updateEarlyRepaymentAndRipple(repaymentId, input, opts?: { today?: string }): number
deleteEarlyRepaymentAndRipple(repaymentId, opts?: { today?: string }): number
```

The three _add_ signatures are **unchanged**: their input already carries the date
and the owning id (`liabilityId` on `AddBalanceAnchorInput`,
`liability-store.ts:127-134`; `planId` on the revision/repayment inputs, `80-87`,
`102-111`), so they were never leaking. The only `liabilityId` that survives on the
seam is the one _inside the add input_, where it is the fact, not a re-read hint.

Inside each update/delete the store widens its existing by-id select to return the
**old date** and the **owning liability** (resolving `planId → liability` for
revisions and repayments, the same lookup `readPlanInputById` already performs at
`liability-store.ts:560`, `679`). It then derives the from-date exactly as today —
`min(old, new)` on edit, the row's date on delete — and ripples with the `kind`
each fact already uses (`anchor`, `amortizable-revision`, `amortizable-repayment`).

**Stale-data handling — uniform `number` contract, no throw.** The store reads the
row by id; if it is absent (deleted or never existed) the write affects no rows and
the method returns `0` and ripples nothing — the existing `if (!existing) return 0`
guard (`liability-store.ts:823`, `851`, `555`, `592`, `674`, `710`) becomes the
single not-found signal, no longer a no-op padded by a caller-supplied fallback
date. On success the method returns `1` and ripples from the derived date. The
caller maps `0` to "ya se haya eliminado" exactly as it does now
(`actions.ts:1544-1549`). Last-write-wins on concurrent edits is acceptable: this is
a single-store, single-writer app and every read-then-write sits in one
better-sqlite3 transaction, so the read and write never straddle another commit.

## Considered options

- **Keep `previous*Date`, drop only `liabilityId`** — rejected. It removes one leak
  but keeps the one that matters: the caller still reads the row before the write,
  duplicating the store's own select and reintroducing the read/write skew the
  transaction exists to prevent. The point of ADR 0020 is that the seam owns
  everything the ripple needs; a half-self-contained seam is the convention-by-hand
  ADR 0020 set out to delete.
- **Throw a typed `NotFoundError` instead of returning `0`** — rejected. The
  internal writes already return `result.changes` and the action layer and tests
  branch on `0`/`1` (`actions.ts:1169`, `1544`; `debt-historical-snapshots.persistence.test.ts:693`,
  `722`, `750`, `781`, `849`). A throw would force try/catch around a control-flow
  case that is not exceptional (a stale form re-submit) and churn green tests for no
  invariant gain.
- **Return the resolved old date / from-date to the caller** — rejected. It would
  re-expose the internal the decision is hiding and tempt callers to recompute the
  ripple window. The from-date stays strictly behind the seam.

## Consequences

- The pre-write `readBalanceAnchors().find(...)` / `readInterestRateRevisions().find(...)`
  / `readEarlyRepayments().find(...)` blocks delete from all six edit/delete actions
  (`actions.ts:1153-1155`, `1220-1222`, `1344`, `1413`, `1528-1530`, `1594-1596`);
  the action layer reaches the parse-and-delegate shape ADR 0020 promised. This
  gates #315 (balance anchor) and #316 (revision + repayment).
- The ADR-0020 invariant holds and tightens: every public dated-fact method still
  ripples, and now the from-date is derived **only** behind the seam — no public
  signature even names a date the caller could pass instead of the truth in the row.
- Dependency direction is untouched: orchestration stays in `packages/db` (the
  widened by-id read, the from-date `min`, the `rippleHistoricalSnapshotsForDebt`
  call), pure recalculation stays in `packages/domain`. No new import crosses the
  boundary; the store reads one extra column on a select it already issues.
- The persistence tests (`debt-historical-snapshots.persistence.test.ts:310-313`,
  `716-722`, `744-750`, `775-781`, `803-809`, `843-849`) drop their `previous*Date`
  and `liabilityId` opts. Their `expect(changes).toBe(1)` / `toBe(0)` assertions are
  unchanged — the contract narrows, it does not move.
- No new domain noun. "Dated fact," "ripple recalculation," and "from-date" already
  name the concepts (CONTEXT.md, ADR 0012, ADR 0020); this decision only relocates
  the old-date read to the side of the seam that always owned it.
