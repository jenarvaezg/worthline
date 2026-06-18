# The historical-snapshot monolith splits into a pure core seam plus one module per ripple trigger

## Context

`packages/domain/src/historical-snapshot.ts` is a ~1345-line pure-domain module. It is
genuinely pure: it imports only sibling domain modules (`./amortization`,
`./classification`, `./holding-valuation`, `./snapshot-holdings`,
`./scope-allocation`, …) and **no `db`** (grep-confirmed: no `@worthline/db`,
drizzle, or better-sqlite3 import). The split must keep it that way.

The file carries three layers of responsibility:

1. **Date arithmetic** — `lastDayOfMonth`, `addMonths`, the exported
   `amortizationPaymentDatesUpTo` (drives the amortizable per-cuota density), and
   `historicalCapturedAt`.
2. **The generation seam** — `buildSnapshotAtDate`, which reconstructs a
   _brand-new_ valued snapshot for a scope on a past date, plus its private
   valuation-input helpers `assetValuationInput`, `liabilityValuationInput`, and
   `debtCurveValuationInput`.
3. **The amendment seam** — six exported `recalculateSnapshotFor*` functions plus
   `globalHoldingValueAtDate`, each of which swaps **one** holding's row on an
   _already-frozen_ snapshot and re-derives the five headline figures, preserving
   every other frozen row verbatim (ADR 0012, ADR 0008).

A factual correction the split must encode (the issue's premise is slightly off):
the recalc (ripple) functions do **not** call `buildSnapshotAtDate`. The two seams
are different operations — generation builds a snapshot from scratch; amendment
edits one row on an existing one. What they _share_ is the lower layer:
`assetValuationInput`/`liabilityValuationInput`/`valueAt` (valuation), and — for the
amendment side — three additional shared helpers: `resolveFrozenIdentity` (the
single frozen-vs-live identity seam, #242), `allocateScopedHolding`, and
`assembleRippleSnapshot` (the row-reconcile-and-capture seam, #181). Every recalc
funnels through these three. That shared math — not `buildSnapshotAtDate` alone — is
the central seam that must stay un-duplicated. (Also: the file exports **six**
`recalculateSnapshotFor*` functions plus `globalHoldingValueAtDate`, not "nine" — the
nine in the issue conflates these with the db-layer ripple orchestrators.)

The public surface is already indirect: `packages/db` imports every snapshot
function from the `@worthline/domain` **barrel** (`packages/domain/src/index.ts`),
never from the file path. The db ripple orchestrators
(`rippleHistoricalSnapshotsForOperations` et al.) call these as pure functions; the
dependency direction (`db` over pure `domain`) is settled by ADR 0020.

## Decision

Split `historical-snapshot.ts` into a **core module** that owns the date arithmetic
and **both** shared seams, plus **one trigger module per ripple kind**. Every
trigger module imports its seam from the core and adds no snapshot math of its own.
The barrel keeps the public surface byte-stable.

File → functions:

- **`historical-snapshot.ts`** (core, unchanged path) — `lastDayOfMonth`,
  `addMonths`, `amortizationPaymentDatesUpTo` (exported), `historicalCapturedAt`
  (exported), `debtCurveValuationInput`, `assetValuationInput`,
  `liabilityValuationInput`, `buildSnapshotAtDate` (exported — the generation seam),
  `resolveFrozenIdentity`, `assembleRippleSnapshot`, and `globalHoldingValueAtDate`
  (exported — the shared global-revalue helper that #320 _and_ #321 both depend on).
  Exports the now-shared seam helpers (`resolveFrozenIdentity`,
  `assembleRippleSnapshot`, the valuation-input builders) plus the
  `Frozen*`/`Curve*`/`*Input` types the trigger modules need. This is the central
  pure seam; no trigger module reimplements it.
- **`historical-snapshot-operation-ripple.ts`** (#320) — `recalculateSnapshotForAsset`;
  trigger category **operations**.
- **`historical-snapshot-position-ripple.ts`** (#320) —
  `recalculateSnapshotForCoinAcquisition` and `recalculateSnapshotForConnectedValue`;
  trigger category **position revalues** (Numista coin acquisition + Binance/
  connected-value, ADR 0017/0021).
- **`historical-snapshot-anchor-ripple.ts`** (#321) — `recalculateSnapshotForHousing`
  (**valuation anchors**) and `recalculateSnapshotForLiability` (**balance anchors**
  - **amortization plans** — one function, since `debtCurveValuationInput` already
    dispatches anchored vs. amortized by `debtModel`). Amortization-plan density stays
    in the core's `amortizationPaymentDatesUpTo`, called by the db orchestrator, not
    duplicated here.
- **`historical-snapshot-ownership-ripple.ts`** — `recalculateSnapshotForOwnership`;
  trigger category **ownership splits** (the scope-axis ripple of ADR 0020). It is
  the odd one: it re-weights along the **scope** axis, not time, so it earns its own
  module rather than folding into #320/#321.

The `OwnershipRippleHolding` type moves with the ownership module; each
`Recalculate*Input` interface moves with its function. Shared types
(`FrozenIdentityCapture`, `HousingCurveInputs`, `DebtBalanceCurveInputs`,
`BuildSnapshotAtDateInput`, `GlobalHoldingValueInput`) stay in the core and are
imported by the trigger modules.

**Public dispatch surface:** unchanged. The barrel (`packages/domain/src/index.ts`)
keeps re-exporting every currently-exported name (`buildSnapshotAtDate`,
`amortizationPaymentDatesUpTo`, `historicalCapturedAt`, `globalHoldingValueAtDate`,
all six `recalculateSnapshotFor*`, and every `*Input`/`Frozen*` type) — but the
re-export lines now point at the new file paths. Because `packages/db` and tests
resolve through `@worthline/domain` only, **zero db/test import statements change.**
The split is invisible above the barrel.

**Purity:** every new module imports only from sibling `domain` modules and the
core. No `db` import is introduced. The generation seam (`buildSnapshotAtDate`) and
the amendment seam (`resolveFrozenIdentity` + `assembleRippleSnapshot` +
valuation-input builders) live in exactly one place; trigger modules delegate to
them and contain only their per-trigger row-shaping.

## Considered options

- **Split by trigger only, leave `buildSnapshotAtDate` in core, but inline the
  recalc-shared helpers into one of the trigger files** — rejected.
  `resolveFrozenIdentity`/`assembleRippleSnapshot` are used by all six recalcs;
  parking them in (say) the operation module would make #321's anchor module import
  from #320's operation module, coupling the two AFK slices that were deliberately
  separated. The shared seam belongs in the neutral core both slices already import.
- **One module per recalc function (six trigger files)** — rejected. Coin-acquisition
  and connected-value ripples are both position revalues over the same
  `globalValueMinor`/`globalDeltaMinor` shape and ship together in #320; housing and
  liability ripples are both curve-anchor ripples shipping together in #321. Grouping
  by trigger category (not by function) matches the issue's carve and the db
  orchestrators (`rippleHistoricalSnapshotsForValuation`/`ForDebt`).
- **Fold ownership into the #321 anchor module** — rejected. Ownership is a scope-axis
  ripple (ADR 0020), re-weights through `globalHoldingValueAtDate`, declares no new
  date, and gates neither #320 nor #321; it stands alone.
- **Drop the barrel; let db import the new file paths directly** — rejected. It would
  rewrite ~16 import lines in `db/index.ts` and the test suite for no benefit. The
  barrel is the established public surface (ADR 0020's "behind the seam"
  arrangement); keeping it stable is the whole point of a low-churn split.

## Consequences

- The ~1345-line monolith becomes a ~600-line core plus four focused trigger
  modules, each under the 800-line house ceiling, each independently testable.
- `buildSnapshotAtDate` stays the single generation seam and
  `resolveFrozenIdentity`/`assembleRippleSnapshot`/the valuation-input builders stay
  the single amendment seam — no trigger module duplicates snapshot or reconciliation
  math, so the ADR-0008 reconcile invariant keeps firing in one place.
- #320 (operation + position ripple) and #321 (anchor + amortization-plan ripple) can
  be extracted independently by an AFK agent: each touches only its own new file plus
  the barrel re-export line, and depends on the core's already-exported seam. Neither
  reopens this design.
- `historical-snapshot.test.ts` (large) splits along the same trigger seams in a
  follow-up; the core's seam functions become directly testable now that they are
  exported.
- No new domain noun. "Ripple," "frozen identity," "valuation anchor," "balance
  anchor," "amortization plan," "position revalue," and "ownership split" already name
  these concepts (CONTEXT.md, ADR 0012/0017/0020/0021). The new files are
  implementation homes, not new terms.
