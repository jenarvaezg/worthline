# A traspaso is its own pair of kinds, and the inherited cost travels on the row

## Context

The Spanish **traspaso** — moving a fund position to another fund without cashing it in
— is the single most common operation in Jorge's ledger and the app had no word for it.
Recording one as a sale plus a purchase is what the app forced him to do, and his
verdict was blunt:

> «Es un tostón y no queda bien.»

It does not just read badly, it is wrong in three separate ways:

- **It realizes a gain that did not happen.** `derivePosition` folds a `sell` into
  `realizedMinor` (#548). A traspaso is tax-neutral by construction — that is the whole
  point of the instrument — so every traspaso in the book inflated realized P/L and
  deflated the latent gain that should have travelled with the capital.
- **It resets the cost basis.** The purchase leg gets `units × price` as its cost, so
  the destination is born looking freshly bought. Years of latent gain vanish from the
  ficha the day the capital moves.
- **It has no atadura.** Two unrelated rows, no way for the app to know they are one
  move, so the UI cannot show them as one and no writer can guarantee both or neither.

## Decision

**A traspaso is a pair of first-class operation kinds tied by a shared id, and the
acquisition cost the units carry over is persisted on the incoming row.**

1. **`transfer_out` / `transfer_in`, not a flag on `sell`.** `OperationKind` grows from
   two members to four. The alternative — `sell` plus a `transfer_id` column — is
   opt-out semantics: every fold that must NOT realize a gain would have to *remember*
   to look at the column, and the one that forgets fails open and silently. With their
   own kinds the compiler refuses a fold that has not said what it does with them, and
   the barrido that came with this decision found three folds that would have been
   silently wrong (the measured savings, the delta breakdown, the agent view's summary).

2. **`transfer_id` on both halves, and on nothing else.** It is what lets a reader pair
   them, an atomic writer name them, and the UI print them as one move. `batch_id`
   cannot serve: it groups a whole import, so it does not say "these two are one move".

3. **`transfer_cost_minor` is persisted on the `transfer_in`.** The origin computes the
   proportional cost of the units leaving — the same arithmetic as `costOfUnitsSold` —
   and that figure travels as a column of the incoming row. It is deliberately not
   recomputed at read time by crossing over to the origin: `derivePosition` folds the
   ledger of **one asset**, and that purity is what makes the engine testable and the
   snapshot ripple bounded. Exact precedent: the `capture_*` columns of #1401 (ADR
   0072). No invented history either — there is no fabricated purchase anywhere.

4. **Cashflow yes, realized gain no.** At *holding* level a traspaso is a real flow:
   capital left this product on that date at that date's market value, so the IRR must
   see it or a fund transferred away a year in would be measured over a life it never
   had. At *portfolio* level the two halves are equal and opposite on the same date and
   cancel by construction. `realizedMinor` is the one figure a traspaso never moves.
   Today `sell` conflates flow and gain in a single kind; these two separate them.

5. **The over-sell clamp applies unchanged.** A `transfer_out` that exceeds the units
   held is clamped with a warning, exactly like a sale — a position never goes negative.

6. **A fee belongs on the incoming half.** The outgoing half has no realized P/L to
   charge a commission against, so a transfer fee is capitalized into the destination's
   cost, exactly as on a buy.

7. **A traspaso row is minted only by its own gate.** The row-level rules (a transfer
   carries its `transferId`; a `transfer_in` carries its inherited cost; nothing else
   carries either) throw rather than becoming user-facing violations: nobody types these
   columns into a form. The statement merge is narrowed to buys and sells and refuses to
   overwrite half a pair — a file listing the day the capital left could otherwise
   rewrite a `transfer_out` as a sale and orphan its other half in silence.

## Alternatives considered

- **`sell` + `transfer_id` (rejected).** Fail-open, as above. It is the same shape as
  the fabricated-ceremony guard of #1468: a rule that only works while every reader
  remembers it.
- **Cross to the origin's ledger at fold time to derive the inherited cost (rejected).**
  Breaks the one-asset purity of `derivePosition`, makes every position fold depend on
  another holding's history, and multiplies the ripple's reach.
- **Count a traspaso as zero flow everywhere (rejected).** It would hand the origin's
  drop and the destination's rise to the market band of the delta breakdown, printing a
  loss and a gain that never happened.
- **Count it as savings (rejected).** The measured savings (ADR 0075) is money that came
  from outside; a traspaso only changes which product holds money already invested. Per
  holding it would report a saving nobody made, and the FIRE projection rides that
  figure.
- **Count the incoming half against a contribution allowance (rejected).** Moving a
  pension plan to another manager is not a contribution; counting it would eat a whole
  year's ceiling (ADR 0080) on the day the capital merely changed hands.

## Consequences

- Schema v59: `asset_operations.transfer_id` and `asset_operations.transfer_cost_minor`,
  both nullable, nothing backfilled — a pre-#1393 row genuinely knows of no pair.
- `OperationKind` has four members. Every fold over it now states what it does with a
  traspaso, and a fifth kind will not compile until it does the same.
- The workspace transfer document carries both columns, so an export → import
  round-trip cannot quietly drop the atadura or the inherited cost.
- The agent view reports the halves as what they are, paired by `transferId`, and counts
  them apart from buys and sells.
- Not covered here: the atomic write gate that mints (and deletes) both halves together
  (#1479), the "Traspasar" screen (#1480), the ledger and drilldown surfaces (#1481),
  and the dictated traspaso (#1482). Until #1479 lands, no product path writes a
  traspaso — this slice teaches the engine to read one.
