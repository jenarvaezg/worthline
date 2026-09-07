# A holding is split into céntimos once

## Context

«¿Cuánto de este holding es renta variable?» is one question. Three places in the
domain answered it, each with its own arithmetic:

- **The exposure look-through** (ADR 0039) split a holding's value across its
  declared class vector by **largest remainder** over the exact decimal weights,
  so the parts reconciled to the holding's value with nothing left over.
- **The per-asset-class rentabilidad** (#552, ADR 0040) rounded each weight to
  **basis points** (`Math.round(weight × 10000)`) and multiplied bucket by bucket.
- **The class drill-down** (`filteredValueMinor`) multiplied the single filtered
  weight and rounded **half up**, on its own, with no whole to reconcile against.

On a weight that falls on exact basis points and a value that falls on exact
céntimos the three agree, which is why this survived. On a dirty one they do not.
A 60/40 declared as `0.60005 / 0.39995` over 1.000,01 € gave 600,06 / 399,95 on
the exposure screen and 600,11 / 400,00 on the rentabilidad screen — a céntimo
apart per class, and nine céntimos that no holding contained. The drill-down could
land a third answer again: three thirds of 1,00 € gave the sleeve 0,33 € where the
slice above it showed 0,34 €.

Both modules **documented** the divergence instead of removing it — «reconciles at
display (€) granularity, not necessarily to the cent». That is #1422 at the scale
of the céntimo: two figures for one question, each honest about its own method,
and no way for a reader to tell which one the money is actually in.

## Decision

**A holding's value is split into céntimos once, by one function, over all of its
buckets at a time. Every surface reads that split; none re-derives it.**

1. **The split lives in the decimal seam.** `splitMinorByWeights(amountMinor,
   destinations)` in `decimal.ts` is the app's only largest-remainder allocation:
   each part floors, the leftover céntimos go to the parts that lost the biggest
   fraction, ties break by key. It **floors** rather than truncating toward zero,
   so a negative total reconciles by the same rule. It returns every destination,
   zeros included — a bucket worth nothing today is still a bucket the caller
   asked about (#1456: the domain marks, it never omits).

2. **The destination vocabulary is one reading too.** `breakdownDestinations`
   (`exposure-lookthrough.ts`) turns a stored vector into its declared buckets
   plus the undeclared remainder in `other`. Agreeing on the céntimos is worthless
   if the two surfaces disagree on which buckets exist: a look-through that
   invents an `other` its sibling has not got is a divergence no rounding rule can
   repair. `OTHER_ASSET_CLASS_KEY` is an alias of that key, not a second spelling.

3. **A split spans the holding, never a bucket.** `returnsByAssetClass` runs one
   `splitMinorByWeights` pass over the holding's whole value and hands each class
   the céntimos it was awarded. Rounding bucket by bucket is what let the parts
   stop adding up.

4. **A weight has one spelling: the decimal.** `SubsetReturnsSlice.share` is a
   `DecimalString`, not basis points, and it scales the **ledger** — cashflows and
   monthly closes — through `scaleMinorByWeight`, which rounds half up toward +∞
   exactly as `allocateByBps` does, so a weight and its bps twin agree wherever
   both can express the same fraction. `ownershipBps` stays in basis points beside
   it because that is how ownership is **stored** (`shareBps` on the ownership
   rows), not a rival spelling of the class weight.

5. **A value arrives at `subsetReturns` already attributed.** The engine no longer
   derives a slice's value from its share: the split that gets it there sees every
   bucket of the holding at once, and a single slice cannot. `share` therefore
   never touches `marketValueMinor`.

## Consequences

- **Over one holding value, a class `value` equals its `exposure.assetClass`
  slice to the céntimo**, and the class values add back up to the holding. The
  caveat the two modules carried is deleted rather than reworded.
- **The two screens still choose their own input, and that is not this ADR's
  business.** `load-patrimonio` gives the look-through every asset row at its
  scope-weighted value and gives the class engine the market instruments gross —
  so the totals differ by euros, by design (an appreciating asset has no IRR to
  report). This ADR removes the divergence that had nothing to do with that
  choice: one weight over one value answering twice. A reader comparing the two
  screens' totals is comparing two different portfolios, which the surfaces say.
- **The drill-down agrees with the slice it drills into.** `filteredValueMinor`
  takes its bucket's part out of the same split; `multiplyMinorByWeight` is gone.
- **This is a reconciliation rule, not a returns change.** The IRR/TWR engines are
  untouched; what changed is which céntimo each slice starts from. The measures
  move only where the old bps rounding was already wrong.
- **The look-through's own figures are unchanged**, because it was already the
  correct one — geography, currency and sector keep routing their remainders to
  coverage rather than to `other`, exactly as ADR 0065 has it.
- **The weight is still present-time.** Nothing here makes a class weight
  historical: it is still applied uniformly across a holding's history, the
  approximation ADR 0039 declares. One split does not make a lens a fact.
