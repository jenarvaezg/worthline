# ADR 0083 — A traspaso enters and leaves the book by one door

- Status: accepted
- Date: 2026-08-19
- Issue: #1479 (slice 2 of #1393)
- Supersedes / amends: nothing. Completes ADR 0082 (a traspaso is its own pair of
  kinds), whose "no product path writes a traspaso" is what this closes.

## Context

ADR 0082 taught the engine to READ a traspaso: two kinds, a shared `transfer_id`, and
the inherited cost persisted on the incoming row. It deliberately stopped there — the
row constructor validates one row, and the pair's invariants are not visible from
inside one.

What a writer of a traspaso has to guarantee, and none of the existing write paths can:

- **Both halves or neither.** A `transfer_out` with no matching `transfer_in` takes
  capital out of the book — the 17-day hole of #1393, permanently. A lone
  `transfer_in` claims an inherited cost with no origin that ever gave it up.
- **Three figures nobody should type.** The bank states «traspaso 1.018,67 €»; the
  participaciones of each half are that amount over ITS OWN VL, and the acquisition
  cost that travels is a proportion of the origin's basis. Jorge did that arithmetic
  by hand, in a second form, on a different date. That is what «es un tostón» was
  about.
- **The state it reads is a moment, not "now".** The inherited cost is a slice of the
  origin's cost basis *on the transfer date*.

## Decision

**One command mints the pair and one command removes it, and everything a caller
would otherwise compute lives in a pure plan upstream of them.**

1. **`recordInvestmentTransfer`: two rows, one transaction, one ripple.** Both halves
   and the snapshot reconstruction of BOTH holdings commit or roll back together (ADR
   0020). One batched ripple across the two assets, not one per half: the pair shares
   a date, so a ripple each would re-derive the same band of history twice (#1435).

2. **The arithmetic is a pure module, `planTransfer`.** The gate owns a
   transaction; the plan owns the numbers. That split is what makes every hostile case
   a table test rather than a database fixture, and it is what will let the screen of
   #1480 preview exactly the pair it is about to write, from the same code.

3. **The importe rules, and the units are cut where the app can read them.** Each
   half's participaciones are `importe ÷ its own VL`, rounded to
   `UNITS_READBACK_DECIMALS` — the six decimals `formatUnits` renders (#1395). A raw
   division stores a precision no bank publishes and the ficha cannot print. That
   constant now has ONE home, next to the voice it names; the alta's
   `OPENING_UNITS_DECIMALS` and this gate read the same six.

4. **«Todo» is its own intent, not an amount that happens to be the whole position.**
   It takes the position's units EXACTLY and derives the euro figure from them.
   Dividing at six decimals leaves up to a millionth of a unit behind, and a fund the
   user emptied has to read as empty — a residual position is a phantom holding in
   every list, warning and donut.

5. **An importe over the position is refused, not clamped.** The position fold clamps
   an over-sell with a warning because it is reading a ledger it did not write; a gate
   is the last place that can still say no, and a traspaso the bank never executed
   must not enter the book at all. The refusal carries both unit counts, so the
   message can name them and offer «todo» — which is the ordinary case behind a figure
   that is a cent or two over.

6. **The two halves may state DIFFERENT amounts.** The origin is valued the day the
   capital leaves and the destination the day it lands, days apart, so a real traspaso
   does not balance — 739,22 € out and 740,72 € in, measured in Jorge's book on the
   19-ago retyping pass, with the explicit instruction that no validation should demand
   equal amounts. `destinationAmountMinor` is optional and defaults to what left, so the
   ordinary case still asks for ONE figure; forcing that figure onto both halves would
   have bought 1,50 € of participaciones nobody paid for. What ties the halves is the
   `transferId`, never the money.

7. **An external entry is a first-class HALF, not a broken pair.** «Alta por traspaso
   externo» — a plan brought in from another institution — has no outgoing half to
   write, because the origin belongs to someone else's ledger.
   `recordExternalTransferIn` writes ONE `transfer_in` carrying its own `transferId`, so
   a reader that pairs by that id finds one row and can name it instead of reporting a
   broken pair. The alternatives are both wrong: a `buy` eats a whole year of
   contribution allowance (ADR 0080) for capital that merely moved, and a fabricated
   `transfer_out` promises an origin that does not exist. Its inherited cost is
   DECLARED, since nobody here can derive it, and defaults to the amount that arrived —
   the honest reading of "I do not know what these units cost", booking no latent gain
   rather than inventing one. Jorge did this in enero 2026 and will again.

8. **The currency is read from the book, never declared.** Both halves take the
   holdings' own currency, and two holdings that disagree are refused: the inherited
   cost is an amount in the origin's currency written onto the destination's row, and
   crossing currencies would need a rate nobody stated (#1401).

9. **The user's figures are data; structural impossibilities throw.** A non-positive
   importe, a VL of zero, an importe over the position, two currencies, origin =
   destination → `DomainResult` violations a screen renders beside the field. An
   unknown holding, a non-investment one, a connected one → throw. The database is
   per-workspace (ADR 0030), so the tenant scope IS the query and a holding from
   another workspace is one this book has never heard of — a bug or an attack, not a
   typo worth coaching.

10. **The pair leaves by one door too.** `deleteOperation` REFUSES half a traspaso, and
   `deleteInvestmentTransfer` removes both rows with one ripple. The operations table
   already renders each half as a line with its own «Eliminar», so the row-level
   delete is translated at the action: a click on half a traspaso means «deshaz el
   traspaso». Without the refusal in the store, every future writer would have to
   remember the same rule — the fail-open shape ADR 0082 rejected for the kinds.

## Alternatives considered

- **Two `recordInvestmentOperation` calls at the call site (rejected).** Cannot promise
  both-or-neither, and each caller would re-derive the units and the inherited cost.
  The second call failing is exactly the state the ledger has no way to describe.
- **Compute the inherited cost inside the plan by reading the origin's ledger
  (rejected).** The plan would stop being pure and would need a store. The gate folds
  the origin once and hands in two figures from that ONE fold — taking them from two
  folds could slice a cost that never belonged to those units.
- **Clamp an over-position importe like the fold does (rejected).** It would store an
  amount the user never stated and silently disagree with the bank's confirmation.
- **Let the gate mint the ids (rejected).** A replayed submit would land on a second
  pair. The ids are a function of the submission (#1394), which is the caller's to
  derive — and the store must not read a clock of its own (ADR 0024).
- **Let the row-level delete through and pair up afterwards (rejected).** Same
  fail-open as a `sell` with a flag: it works only while every deleting path
  remembers.
- **Demanding the two halves balance (rejected).** It reads like an invariant and is
  false in the data — see decision 6.
- **Recording an external entry as a `buy`, or as a pair with a fabricated origin
  (rejected).** See decision 7.

## Consequences

- No schema change: v59 already carries both columns.
- `DomainViolation` grows seven traspaso codes, so `mapDomainViolation`'s exhaustive
  switch refuses to compile until each has a Spanish message.
- `planTransfer` is the single spelling of the traspaso arithmetic. #1480's screen and
  #1482's dictated traspaso call it for their previews; neither re-derives units.
- `planStatementMerge` no longer proposes deleting half a traspaso, even one carrying
  `source: "opening"` — which every row the #1485 retyping pass re-typed from an alta
  does, and Jorge's book already holds 42 of them. `replaceOpening` exists to drop the
  SYNTHETIC opening balance an alta minted, never a fact of the ledger; without the
  filter a statement import over such a holding would hit the store's refusal and abort
  the whole load for a row nobody meant to touch.
- A residual position IS reachable through the `amount` branch: an importe equal to the
  whole position leaves up to a millionth of a unit behind, because the exact figure is
  rarely representable in cents. That is inherent to stating a traspaso in euros, and it
  is the reason «todo» exists; the screen of #1480 should steer an amount that covers
  essentially everything towards it.
- A traspaso whose origin later receives a BACKDATED purchase keeps the inherited cost
  it was written with. That is the cost of persisting it on the row (ADR 0082) and it
  is deliberate: re-deriving it at read time is what that ADR rejected. The correction
  is to delete the traspaso and record it again — which is now one action.
- Still not covered: the ledger and drilldown surfaces (#1481), the dictated traspaso
  (#1482), and the retroactive re-typing of pairs already recorded as sell + buy
  (#1485).

## Amendment (#1480, 21-ago-2026) — the screen took the offer

The "Traspasar" screen shipped and it does call `planTransfer` for its preview, as the
consequence above anticipated: `transfer-form.ts` is shared by the island and the
server action, so the participaciones on screen, the refusal shown beside the field and
the rows written are one derivation. Two things the ADR left implicit turned out to
matter enough to write down:

- **The preview folds `operationsUpTo(executedAt)`, not today.** A traspaso is
  routinely recorded weeks late, and a position folded on page load is today's: the
  screen would print figures the gate then refuses (or accept an importe the holding
  never held on the day). The ledger therefore travels to the client, and the fold
  happens per keystroke inside `previewTransfer`.
- **The screen creates the destination holding.** A traspaso to a plan just opened is
  the ordinary case, so `recordTransferAction` writes the holding — inheriting the
  origin's instrument, currency and owners — before calling the gate, and only after
  the figures have passed the same `planTransfer` check the gate will run. A refused
  traspaso must not leave an empty holding behind. This is a second door onto
  `createInvestmentAsset` beside the add wizard, deliberately: routing through the
  wizard is what would lose the half-filled form.

The «steer an amount that covers essentially everything towards «todo»» note above is
NOT implemented: «todo» is offered as its own choice, naming the participaciones the
position holds on the chosen date, but an importe a cent over is still refused with the
message that offers it rather than being silently upgraded.

## Amendment (#1481, 21-ago-2026) — the row says which door

The ledger surface now tells the user what the delete translation above means before
they hit it: a traspaso row's «Eliminar» confirm carries «Se elimina el traspaso
entero: las dos mitades», so the pair leaving by one door is announced at the row, not
discovered after the redirect. The reader-side pairing itself is ADR 0082's amendment.
