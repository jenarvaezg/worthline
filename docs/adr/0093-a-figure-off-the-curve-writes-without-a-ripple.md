# A figure off the curve writes without a ripple

- Status: accepted
- Date: 2026-08-27
- Issue: #1441

## Context

Every housing write in the book so far has been a point on a curve. A **valuation
anchor**, the **appreciation rate**, the **valuation cadence**, the current value:
change any of them and the property's history is a different history, so ADR 0020
puts each one behind a seam that persists the fact **and** re-derives the affected
**snapshots** atomically. There is deliberately no public store method that
persists a dated fact without rippling — a caller that could forget the ripple is
a correctness bug the type system permits.

#1441 adds the first housing figure that is not on any curve. A property has two
numbers on the day it is bought:

|            | escriturado | desembolsado |
| ---------- | ----------: | -----------: |
| Yeles      |   48.000 €  |  53.354,55 € |
| Plasencia  | 103.661,34 €| 110.718,95 € |

The **acquisition cost** is the second column: what left the owner's pocket —
escritura price plus ITP/AJD, notaría, registro, gestoría. The **acquisition
anchor** is the first: the market value that day, which is why it carries
`adjustsPriorCurve: true` and starts the property's history. Before this ticket
the app asked for one word («Precio de adquisición») and stored it as the other,
and Jorge and Jose spent an evening each defending a different number for one
field. Both were right; the field was wrong.

The question this ADR answers is not whether to store the cost. It is what the
seam for it looks like, given that ADR 0020's rule is stated as *housing writes
ripple* and this one must not. Two shapes were available: put it behind
`store.command.*` like every other housing write and have that method skip the
ripple, or keep it off that surface entirely.

## Decision

A figure that **no engine reads** is written through the plain store, not through
the dated-fact command surface.

Concretely, for the acquisition cost:

- **A plain nullable column**, `assets.acquisition_cost_minor`, beside
  `annual_appreciation_rate` — not a row in `asset_valuations`. It is one figure
  about the holding, not a dated fact about a day, and it has no date of its own
  (the acquisition **date** already belongs to the anchor).
- **`assets.setAcquisitionCostMinor` is the seam**, and it is the only housing
  write with no ripple in it. `executeSetHousingAcquisitionCostCommand` calls it
  directly and does **not** go through `store.command.*`.
- **That bypass is the point, not an omission.** Putting the method on the
  persist-and-ripple surface would mean one member of that surface whose contract
  is «persists, and does NOT ripple» — the exact ambiguity ADR 0020 removed. The
  frontier ADR 0062 draws stays where it is: the command layer is the mutation
  barrier for facts that move figures, and this figure moves none.
- **Nothing in the engine may read it.** `valueHousingAtDate`, **housing
  equity**, the implied LTV and every frozen snapshot are cut from the value
  anchors alone. This is the invariant that licenses the whole shape, so it is
  pinned by a test that saves a cost and asserts an earlier snapshot is
  byte-identical — sitting directly beside the test that asserts a **rate** change
  does recut that same snapshot.
- **In the alta it still rides the anchor's transaction.** `createHousingHolding`
  takes the cost and writes it inside the same transaction as the anchor (ADR
  0020's atomicity for the alta, since the form collects both at once), and it
  widens the ripple by nothing: the from-date is still the acquisition date.

Two consequences follow, and both are load-bearing:

- **No backfill, ever, from the anchor.** The four properties on the book hold a
  mixed figure in their anchor. A migration that copied it into the cost column
  would turn a confusion into data. They read `null`, which says «nobody has read
  the escritura yet» — an honest state.
- **Null is the only «unknown», so zero is refused.** A stored `0` would be a
  third state, and it renders as a result of «+the whole value», which is the
  fabricated figure this ticket exists to prevent. Both the web parser and the
  store seam refuse a non-positive amount; `null` clears.

## Consequences

The reading rule for a new housing figure becomes a single question: *does any
engine read it?* Yes → ADR 0020, behind the persist-and-ripple seam. No → a plain
column and a plain store method, with a test that proves the past did not move.
The cost of getting it wrong is asymmetric and known: a fact that should ripple
and does not leaves a silently stale history (#1436), while a figure that ripples
and need not merely rewrites snapshots to the same values — expensively, and while
claiming a recalculation the user cannot see the reason for.

What this does **not** license: reading the cost into any derived figure later. A
property's **return** measured against its cost is a reporting lens on the same
footing as **exposure** and **return** for investments — computed on read, never
frozen into a snapshot (ADR 0040). #1441 ships exactly one line of it («Resultado
frente al coste» = current value − cost) and no IRR, no TWR, no `ReturnsPanel`;
if those arrive they arrive as `derived`, not by teaching the curve about the cost.

Financing stays out of the figure entirely. The comisión de apertura and the
bank's insurance are cost of the **loan**, not of the asset (art. 35 LIRPF), so a
third «coste de financiación» number would break both comparability between
properties and the fiscal base the figure is meant to mirror.
