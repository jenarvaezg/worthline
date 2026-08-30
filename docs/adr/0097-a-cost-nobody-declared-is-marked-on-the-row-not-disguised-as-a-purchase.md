# A cost nobody declared is marked on the row, never disguised as a purchase

## Context

An alta declares a position that **already existed**. Until #1490 the wizard asked only
what it is worth, so the synthetic apertura went in at today's price and dated today —
Jorge's 27 uds of the SXR1 landed as «comprado hoy por 5.865,75 €», his 865,89 € of
latent gain erased and August grown by a 5.865,75 € contribution he never made.

#1490 fixed the question: the alta now asks for the acquisition cost and says out loud
what an empty answer means («Sin coste no habrá plusvalía: la posición nace valiendo lo
que vale hoy»). That is the right question, and «no lo sé» is often the truthful answer
about a fondo held for eleven years.

What #1490 did not fix is what happens to the answer. With the cost left empty the
opening is still written at today's price, so the row is byte for byte a purchase made
today:

```
2026-08-19  buy  27 uds @ 217,25  (source: opening)
```

The only trace of «este coste no lo sabe nadie» was the copy in the pane, and it died
with the submit. Three consequences, all of them silence:

- the ficha printed **`P/L latente 0,00 €` as a fact**, when the honest reading is
  «no se puede saber»;
- the salud de datos (#654) could not point at the position, because nothing in the
  book said anything was missing;
- nobody could ask for the cost again, for the same reason.

The vocabulary for this already existed and was already written in es-ES: the reconcile
of extractos grades a cost `movements` / `declared_cost` / `value_only` (decisión #1090,
ADR 0048), reading «con movimientos», «coste declarado», «sin coste real». It lived only
in the assistant's proposal, never in the ledger.

## Decision

**The grade of a stated cost is a column on the operation, written once by the alta
door, and every reading of a return respects it.**

1. **`asset_operations.cost_basis_grade`, on the row.** A cost basis is FOLDED from a
   ledger, so the fact about how trustworthy that cost is has to travel on the rows it
   is folded from. A column on the holding would go stale the moment a real buy is
   recorded on top of the apertura. Exact precedent: `transfer_cost_minor` (#1393, ADR
   0082) and the `capture_*` columns (#1401, ADR 0072) — a fact the write gate computes
   once, so the fold never has to leave the one asset's ledger to learn it.

2. **Two values, and a third state that is the absence of both.** `declared_cost` =
   somebody stated this cost; `value_only` = nobody did, and the price is what the
   position was worth that day. NULL is ADR 0048's `movements`: a real dated movement
   whose price IS its cost — a buy, a sell, a statement order — and every row written
   before this decision.

3. **Only an `source: "opening"` row may carry a grade,** enforced by a throw in
   `createInvestmentOperation` alongside the traspaso column rules. No form posts this
   column; the alta fills it. Marking a real buy `declared_cost` would quietly downgrade
   an observed movement to a declaration.

4. **The fold decides for a POSITION, never a row scan.** `derivePosition` carries the
   grade in step with `costMinor`: the worst grade seen taints the moving average, and
   the taint clears when the units reach zero — because a position sold out and bought
   back is a new position, measured against a cost that really was paid. Every reader
   (the ficha, the health signal, the returns list) asks the fold, so none of them can
   nag about a cost that stopped backing anything.

5. **A `value_only` position does not get a latent P/L — it gets the mark.**
   `HoldingReturnsView.unrealizedPnl` comes back `null` and the panel prints «sin coste
   real» in the figure's own slot, plus a caveat naming what else rests on that cost. A
   caveat alone would not do: `0,00 €` is not a limitation to annotate, it is the claim
   that the position has neither gained nor lost, which is exactly what is unknown. The
   caveat channel (ADR 0040) carries the rest, and positions that DO have a declared
   cost are untouched — the reconciliation of those figures is unchanged.

6. **The health signal is `low` and overrideable.** Nothing on screen is wrong: the
   holding is valued by its price, so today's net worth is right to the cent. What is
   missing bites only where a return is read — the same shape as the missing-ISIN signal
   (#1489), and like it, it never reaches the hero. Overrideable because «no sé lo que
   costó» is a permanent, honest answer (ADR 0004).

7. **Nothing is backfilled, and no heuristic guesses.** A pre-#1505 apertura and a real
   purchase made that day are the same row. The available heuristic — opening price ==
   that day's cached price — fails in the direction that matters: a user who really did
   buy at the closing price would have a cost he DID declare overwritten with «sin coste
   real». Only the owner can answer, and asking him is its own piece of work. Legacy rows
   stay NULL, which reads as «nadie lo ha dicho» — which is what they have always been.
   Same posture as the v64 migration of #1441 (`assets.acquisition_cost_minor`), for the
   same reason.

## Scope

This decision covers the **synthetic apertura** — the row both alta doors stamp
`source: "opening"`. It deliberately stops there.

The **alta por traspaso externo** (#1541) has the same hole by the sibling door: when
the user does not declare the inherited cost, `planExternalTransferIn` defaults it to
the importe that arrived, so the `transfer_in`'s cost basis is again today's value
wearing a cost's clothes. It is not marked here because a traspaso row is minted only
by the pair's own atomic gate (ADR 0083, #1479), and widening the column to
`transfer_in` means going through that gate — a decision with its own blast radius.
`assertCostBasisGrade` refuses the grade on any non-opening row precisely so this is a
compile-time line rather than a half-applied rule, and the `transfer_in` branch of
`derivePosition` says so where a reader would otherwise see an omission.

## Alternatives considered

- **A grade on the holding (rejected).** A holding-level mark cannot survive a real buy
  landing on top of the apertura: it would either keep claiming «sin coste real» over a
  cost basis that is now mostly real euros, or be cleared and lose the taint the moving
  average genuinely still carries. The ledger is where the fact belongs.
- **A boolean `cost_is_unknown` (rejected).** It would conflate «a real movement» with
  «an alta that WAS given a cost», and that is precisely the distinction a later pass
  needs to tell a post-#1505 answer from a pre-#1505 silence. It would also invent a
  second vocabulary next to the reconcile's three grades, which already have es-ES copy.
- **Withhold every measure, not just the latent P/L (rejected).** IRR, TWR and the simple
  gain do rest on the same cost, but the caveat channel is what ADR 0040 built for
  exactly that — a measure shown with its limit stated. Only the latent P/L is a bald
  positive claim, and only it is withheld.
- **Backfill by heuristic (rejected).** See decision 7.
- **Refuse the alta without a cost (rejected).** #1490 already settled this: a cost
  nobody knows is a legitimate answer, and refusing it would send the user back to a 0 €
  container or to inventing a figure. The point of this ADR is that the app remembers
  the answer, not that it stops accepting it.
