# Declaring a dated fact persists and ripples atomically behind one store seam

ADR 0012 decided the **behaviour**: declaring, modifying, or deleting a **dated
fact about the past** — a backdated **operation**, a **valuation anchor**, a
**balance anchor**, an **amortization plan** — generates the snapshot for that
date and re-derives the existing **snapshots** it affects. This ADR decides
**where that contract lives**.

Today it lives nowhere. The act is split in two: a caller persists the fact
through one store method (`recordOperation`, `addValuationAnchor`, …) and then
makes a **separate** `rippleHistoricalSnapshotsFor*` call. There are six such
ripple methods and twenty-three call sites; each action computes the affected
from-date inline and re-derives `today` itself (twenty-four times across the
action layer). The two calls happen to sit next to each other inside the same
store callback, but nothing makes them one operation — a caller can persist a
dated fact and silently skip the ripple. That is a correctness bug the type
system permits, and the closest thing to an owner of the ADR-0012 contract is a
convention repeated by hand.

The dependency direction is settled and not in question: `domain` is pure (it
never imports `db`); `db` orchestrates the ripple by calling `domain`'s pure
recalculation functions (`buildSnapshotAtDate`, `recalculateSnapshotFor*`). The
orchestration already lives in `db`.

## Decision

Declaring, modifying, or deleting a dated fact is **one operation at the store
seam**. Each dated-fact write method persists the fact **and** ripples the
affected snapshots atomically, in a single transaction. There is no public store
method that persists a dated fact without rippling — the six
`rippleHistoricalSnapshotsFor*` methods stop being part of the surface a caller
must remember to call.

Everything the ripple needs lives **behind** the seam:

- the from-date window, derived from the fact itself (no caller computes it);
- the amortization plan's per-cuota snapshot **series** (ADR 0012's deliberate
  density exception, ADR 0019's two dates);
- the one-shot read of the portfolio the recalculation folds over.

`domain` keeps the pure recalculation functions; `db` keeps and consolidates the
orchestration behind these methods. The action layer becomes parse-and-delegate:
it validates the form and calls one method.

## Typed methods, not a polymorphic fact

The seam exposes one **typed method per fact kind** (operation, valuation anchor,
balance anchor, amortization plan, ownership split, coin acquisition), each
pairing persist-and-ripple. We deliberately do **not** introduce a single
`declareDatedFact(fact)` over a discriminated `DatedFact` union yet: the typed
methods keep each fact's persistence and recalculation shape explicit, make the
migration of the existing call sites mechanical, and don't force a second design
decision onto this one. The union can be layered on later if a uniform entry
point earns its keep; nothing here forecloses it.

## Ownership rides the same seam on a different axis

An **ownership split** edit re-derives history too, but along the **scope** axis,
not time: it declares no new date and creates no new snapshot dates — it
re-weights each existing per-**scope** snapshot's row for that holding. It lives
behind the **same** seam (it is still "something changed that re-derives
history"), but it is marked as a scope-axis ripple, distinct from the
time-axis dated facts. Keeping it behind the seam means there is exactly one
place that owns "a declared fact re-derives snapshots," whichever axis it moves.

## Considered options

- **A coordinator module in `domain`** — rejected. `domain` is pure and must not
  know `db`; routing the persist-and-ripple through domain would require a
  port/adapter and an inversion of the current dependency direction. That is
  machinery a local-first, single-store app does not need, and it fights an
  arrangement (orchestration in `db` over pure `domain` functions) that already
  works.
- **A single `declareDatedFact(fact)` over a `DatedFact` union** — deferred, not
  rejected. More uniform, but it bundles a second design decision (the fact
  taxonomy as a closed union) into a change whose point is to close the
  persist/ripple gap. Typed methods reach the same guarantee with a mechanical
  migration.
- **Leave the two calls split, enforce pairing by convention or lint** — rejected.
  A convention is exactly what exists today; it is what twenty-three hand-written
  call sites already fail to guarantee. The contract belongs in the seam, not in
  reviewers' heads.

## Consequences

- "Persisted a dated fact, forgot to ripple" becomes **unrepresentable** through
  the public store surface — the ADR-0012 contract is enforced in one place.
- The from-date and `today` arithmetic, duplicated across the action layer,
  collapses behind the seam; `patrimonio/actions.ts` and the other action files
  shrink toward parse-and-delegate.
- The **test surface moves to the seam**: the persist-and-ripple loop is exercised
  through one store method instead of through Next.js actions that throw
  `redirect()` and get caught in test try/catch blocks.
- This ADR does not change snapshot or ripple behaviour; it is the **home** of
  ADR 0012's behaviour. ADR 0012's rules (generation density, modify/delete
  recalculates from D inclusive, import never re-derives) are unchanged.
- No new domain noun: "dated fact about the past" and "ripple recalculation"
  already name the concepts (CONTEXT.md, ADR 0012). The seam is an
  implementation home for them, not a new term.
