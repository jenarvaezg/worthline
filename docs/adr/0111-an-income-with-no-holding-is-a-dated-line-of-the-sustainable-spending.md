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
   depleting), with its end date beside it when it declares one. **Starting later,
   it is the third line**: «desde el 10 dic 2030, 3.383,56 €/mes más», added to no
   figure of today. The headline is what today's capital supports; adding money that
   has not arrived would put a second clock on the card (ADR 0081 §5).
4. **Declared expenses are subtracted; undeclared ones subtract nothing.** Net or
   nothing is a rule about rent (agency, IBI, empty months), not about a pension.
5. **No owner is declared.** An income with no holding has no ownership split, so it
   counts whole in a scope that covers every active member and is withheld, saying
   why, in a partial one. Attributing it to the member being viewed would invent
   whose it is.
6. **A future income's condition is checked against the declared retirement.** A
   figure that assumes contributing through a date does not apply to someone who
   declared retiring earlier: the declared target age, placed on the calendar from
   the reference member's birth date (ADR 0073). The grain is the month, the grain
   of the data — retiring the same month the contributions stop is the consistent
   case and holds; with the birth year alone, falling in the same year cannot be
   decided without inventing the month and is said so. A broken condition takes the
   income off the card, naming the declared retirement and the missing figure (a
   simulation at that date). Without a declared age, a birth date, or (same year) a
   birth month, nothing is compared: the figure is shown naming its condition and
   what it cannot be checked against. Never the engine's `?? 65`, never a stop date a
   model invents (ADR 0074/0079). An income already in force is not checked: it
   arrives, and the amount arriving is no longer an assumption. Because the target
   age is typed live in the assumptions form (#1450), the check
   (`incomeContributionCondition`) runs from `fireSustainableSpending`;
   `calculateFireForScope` only reports what no assumption moves (declaration,
   window, scope, birth date).
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
- Rentas says an income with no holding counts in the retirement plan's sustainable
  spending, or will from its start, and that a declared retirement before its
  condition takes a future one off. A nominal amount reads the same sentence there
  and on the card, with the direction it would err in.
- The reference member is the oldest one (ADR 0073). In a household of several
  members, an income with no holding has no owner to read a birth date from, so its
  condition is checked against the oldest member's retirement: knowingly imprecise
  for the younger member's pension, and the price of not inventing an owner.
- ADR 0081's refusal stands: the pension is still not an engine input. This amends
  ADR 0108's last open item (the dated card).

## Amendment (#1675) — the double-count cross

Point 1 left one case to S4: an income linked to a holding that is not a property.
The holding's value is capital, and the capital already yields its rung's rate; the
income linked to it is either that yield or money paid out of that capital — a life
annuity, a pension plan drawn as an income. In the second case, declaring both
counts the same money twice: as capital and as income. It is the risk ADR 0081
refused to take inside the engine, and it is how a public pension once stood in the
patrimonio as an invented asset.

1. **A signal, never a veto.** `INCOME_DOUBLE_COUNT` (category `income_coherence`,
   `medium`) is raised once per holding (#1356), naming every income linked to it.
   Nothing is deleted and no figure moves. Whether the income comes out of the
   capital or is what it yields is something only the user knows, so the decision
   stays with the user.
2. **What crosses.** A holding the scope owns, with value above zero, that is not a
   property, and that has at least one linked income that a passive figure can read
   (passive and real, ADR 0108) and that has not ended. One that starts later still
   crosses: the declaration itself is what duplicates, not the calendar. A holding
   at zero is the honest shape of an annuity that has absorbed its capital, so it
   stays silent. So does an excluded income: it counts zero times, so it cannot
   count twice, and its row already says why.
3. **A property stays silent by construction** (ADR 0076). Its rent replaces the
   housing rung's rate and the brick never enters the sellable capital, so the rent
   never adds to the value. Whatever is left to say about a lease (no expenses,
   nominal, ended) its own notices already say.
4. **It can be acknowledged** (ADR 0004). Interest on a deposit or a bond's coupon
   is what the capital yields. The legitimate case is acknowledged once with
   «Es intencional», beside the incomes in the holding's Cobros, and it stays in the
   agent's inventory labelled as intentional.
5. **It headlines the home, unlike its coherence siblings.** Savings and spending
   coherence (ADR 0075, ADR 0099) question only the figures on /objetivos. This
   cross has the holding's value on one side, and the value is part of today's
   patrimonio: a pension capitalized as a holding inflates it by exactly what it is
   worth. The hero's link opens the holding's Cobros.

The rule (`incomeDoubleCount`) and its sentence (`describeIncomeDoubleCount`) live
in one domain module, read by both the engine's collector and the ficha. The home
crosses the incomes it already read for the returns engine, and the agent's
financial context hands over the ones it already read. Only the standalone
data-quality endpoint reads them for itself, once.

