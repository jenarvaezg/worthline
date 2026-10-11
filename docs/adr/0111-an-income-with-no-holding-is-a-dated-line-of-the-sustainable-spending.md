# An income with no holding is a dated line of the sustainable spending, never an engine input

## Context

ADR 0108 let an income exist without a holding (#1672) and #1673 opened the door to
declare one, with its provenance. Nothing read it: a public pension declared from an
official simulation sat on Rentas saying «todavía no cuenta». ADR 0081 had already
refused the obvious place for it — `calculateFire` stays pure SWR with no per-stage
deficit — and named the compatible route: recurring income that shrinks the capital
needed, outside the engine. #1674 (S3 of #1522) is that route.

## Decision

1. **Only incomes with no holding.** A linked income keeps its holding's route. A
   property's rent substitutes its rung's rate and joins the net rents once in force
   (ADR 0076); a future lease on it is not a dated line — its notice already names
   the start (#1511) and it enters through the rate when it begins. Any other
   holding's income is part of the return its capital already yields: adding it
   again would count the same money twice (the cross-check is S4, #1675).
2. **Passive and real, or nothing** (ADR 0108). Undeclared nature or basis, work
   income and a nominal amount stay out, each named on the card. A nominal amount at
   a future date is not today's euros; reading it as such overstates in the dangerous
   direction, and no decay rate is invented for it (the `rent_revision = fixed` veto
   of #1521).
3. **In force today, it joins the income half** and both totals (perpetual and
   depleting). **Starting later, it is the third line**: «desde el 10 dic 2030,
   3.383,56 €/mes más», added to no figure of today. The headline is what today's
   capital supports; adding money that has not arrived would put a second clock on
   the card (ADR 0081 §5).
4. **Declared expenses are subtracted; undeclared ones subtract nothing.** Net or
   nothing is a rule about rent (agency, IBI, empty months), not about a pension.
5. **No owner is declared.** An income with no holding has no ownership split, so it
   counts whole in a scope that covers every active member and is withheld, saying
   why, in a partial one. Attributing it to the member being viewed would invent
   whose it is.
6. **The condition is checked against the declared retirement.** A figure that
   assumes contributing through a date does not apply to someone who declared
   retiring earlier: the declared target age, placed on the calendar from the
   reference member's birth date (ADR 0073; to the month when the month is known —
   with the year alone, the same year does not break it). A broken condition takes
   the income off the card, naming the declared retirement and the missing figure (a
   simulation at that date). Without a declared age or a birth date nothing is
   compared: the figure is shown naming its condition and what it cannot be checked
   against. Never the engine's `?? 65`, never a stop date a model invents (ADR
   0074/0079). Because the target age is typed live in the assumptions form (#1450),
   the check runs in `fireSustainableSpending`; `calculateFireForScope` only reports
   what no assumption moves (declaration, window, scope, birth date).
7. **Provenance travels with the figure** (#1508): source and cut-off date beside
   every income line, «procedencia sin declarar» when there is none.
8. **`calculateFire` is untouched.** No income moves the FIRE number, the funded
   percentage, coast or the projection; a test pins the result identical with and
   without them.

## Consequences

- `ScopeFireResult.standaloneIncomes` carries the report and
  `FireSustainableSpending.incomes` the four lists (current, upcoming, condition
  broken, withheld). Without any income declared, every figure is what it was.
- `get_fire_context` publishes the four lists. It now reads the incomes even under a
  manual `expectedRealReturn` (the #783 skip): the rate ignores them then, the card
  does not.
- Rentas says an income with no holding counts in the sustainable spending, or will
  from its start, and that a declared retirement before its condition takes it off.
- ADR 0081's refusal stands: the pension is still not an engine input. This amends
  ADR 0108's last open item (the dated card).
