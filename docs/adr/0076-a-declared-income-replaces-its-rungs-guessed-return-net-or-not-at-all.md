# A declared income replaces its rung's guessed return — net, or not at all

## Context

The FIRE projection's expected real return is a weighted average of per-rung defaults
(ADR 0013's liquidity ladder, #515): cash 0 %, market 5 %, term-locked 1,5 %, illiquid
3 %, housing 3 %. Those figures are what the app assumes when it knows nothing about a
holding.

For Jorge's flats it knows something. He has four `payout_schedules` declaring rent on
370.000 € of brick — and the app was pricing that brick at 3 %, i.e. 12.950 €/año at a
3,5 % withdrawal, while the declared rents on his share come to about 23.500 €/año. The
housing rung carries **68,7 %** of his eligible pool, so the cheapest default was the
one deciding his whole expected return, his coast figure and his FIRE date.

The obvious fix is the dangerous one. Gross rent over value gives him **6,3 %**, and a
landlord does not live on the gross: the agency, the rent-default insurance, the IBI,
the community fees, the home insurance, the maintenance and the empty months all eat
first. Sealing 6,3 % would overstate by about as much as 3 % understates, and in the
flattering direction — the app would go from pessimistic to optimistic with nothing on
screen saying so.

`payout_schedules` had no cost field, and ADR 0054 states that a payout is income-only
because net-or-gross is the user's judgement, not the app's.

## Decision

**When a holding's income is declared, its own net yield is its expected real return,
substituting its rung's default for that holding alone. The substitution needs a
declared cost, or it does not happen.**

1. **The cost lives on the schedule, as an amount.** `payout_schedules.expenses_minor`
   (schema v57), nullable, in the SAME cadence as `amount_minor`. On the schedule
   because rent and cost share a validity window and an ownership split, and because
   ADR 0054 already treats the schedule as an attribution. As an amount, not a
   percentage, because the user knows his gastos in euros. It adds no figure anywhere:
   net worth, snapshots, the returns engine and the passive-income lens are untouched.

2. **NULL is "not declared", and it derives nothing.** Not a zero — a zero is the
   claim "this flat costs me nothing to hold", which is a statement a user may make and
   the app may not make for him. With no declared cost the rung's default stands and
   the /objetivos FIRE panel says so, naming the gross that is *not* being used. This
   is the guard: never a gross yield in silence.

3. **All-or-nothing per holding.** If any live schedule on the asset lacks a cost, the
   whole asset falls back. Netting only the schedules that happen to declare costs
   would understate them — the flattering direction again.

4. **Only the housing rung.** Rent is inflation-linked, so a net rental yield already
   *is* a real yield, and a flat's real appreciation on top of it is ~0 by construction:
   that is what makes "net rent / value" a real total return. A deposit's interest is
   nominal (2 % under 2 % inflation is 0 % real) and a fund's dividend is a fraction of
   its total return, not the whole of it. A non-property holding with declared payouts
   keeps its rung's rate, silently — nothing is being withheld from the user there.

5. **The rate is share-invariant; the weight is scoped.** Rent, costs and value are all
   declared for 100 % of the property, so a 50 %-owned flat yields the same percentage.
   What the scope owns decides how much that percentage WEIGHS in the pool
   (`assembleFireEligiblePool`), exactly as it decides the capital.

6. ~~**A lapsed schedule is not income.**~~ **Amended by #1521 — see the amendment
   below.** Validity was measured against the same "today" the rest of the screen uses
   (start reached, end not passed — inclusive), and past the end date the flat returned
   to its rung's default. Two of Jorge's rents expire on 2026-09-01 and 2026-10-01, and
   that is exactly the case that showed the rule was wrong: what looked like reading the
   calendar was assuming an answer. The window still decides which past **payouts**
   exist; it no longer decides, on its own, what the flat is expected to yield.

7. **A negative net applies, and is named.** Declared costs above the rent mean a real
   negative yield, which is a real situation — it is applied as-is, never clamped, and
   the panel says "los gastos declarados superan al alquiler" so a minus sign is never
   left looking like an arithmetic slip.

8. **One door.** `calculateFireForScope` takes the schedules and does the substitution
   itself; the home, /objetivos, the figure explanations and the MCP tools all pass what
   they already read. There is no second place where a rate can be resolved, so the
   assistant cannot quote 3 % while the screen shows 4,5 %.

## Amendment (#1521) — what a lease's end date means, and what happens after it

Point 6 above treated a signed `end_date` as an economic fact: past it, the flat pays
nothing and goes back to the housing rung's guess. That reads as the cautious choice,
and it is not a choice at all — it is `stop` assumed in silence, in a case where the
assumption is usually false. A long-term residential lease continues past its signed
date **by law**; the date the owner gets the decision back is the end of the mandatory
term, not the date on the contract. And the assumption had a calendar: on 2026-10-01
two of Jorge's flats were due to drop from their declared net yield to 3 %, lowering
his weighted expected return, raising his coast figure and moving his FIRE date — with
nothing on screen saying anything had happened. Same failure shape as ADR 0074's: an
input with a second source nobody revalidates, and here the second source is the clock.

**Three declarations on `payout_schedules` (schema v66, additive, nothing backfilled),
and the engine reads all three together.**

| Column | Values | NULL means |
|---|---|---|
| `lease_regime` | `residential_long_term` \| `seasonal` \| `vacation` \| `other` | not declared |
| `rent_revision` | `legal_reference` (+ a free label, e.g. IRAV) \| `contractual` \| `fixed` \| `none` | not declared |
| `post_mandatory_term_policy` | `renew_same_real_rent` \| `stop` \| `unknown` | not declared |

A fourth column, `rent_revision_reference`, carries the free label of a
`legal_reference` revision (IRAV). It is documentary: no figure reads it, there is no
legal engine behind it, and it is dropped rather than kept beside a revision it does not
annotate.

1. **NULL is not a default in disguise.** Undeclared, the engine does exactly what it
   did before v66 (`stop`) **and the ficha says so** — the row prints «régimen sin
   declarar · … · al terminar deja de rentar (supuesto: nadie lo ha declarado)». What
   #1521 closed is the silence, not the behaviour: with all three undeclared not one
   FIRE figure moves.
2. **The regime says what `end_date` MEANS, so the policy's default is read from it.**
   In `seasonal` / `vacation` / `other` the date is a real ending and `stop` is honest.
   In `residential_long_term` it is the end of the mandatory term and `stop` is an
   invention, so there the default flips to `renew_same_real_rent`. `unknown` is an
   absence of decision, not a third behaviour: it falls back to the regime exactly as
   an absent value does, and only the copy distinguishes them.
3. **`rent_revision` moves figures — it is not decorative.** Point 4 above substitutes a
   net rental yield for the rung's default *because rent is inflation-linked*, i.e. the
   net yield already IS a real yield. `legal_reference` and `contractual` satisfy that
   premise. `fixed` and `none` break it: the declared yield would be read as real while
   it loses purchasing power every year — overstating, in the dangerous direction, which
   is the error "net or nothing" exists to prevent. There the engine **refuses to read it
   as real**: notice, the rung's default stays, and **no invented decay rate**. worthline
   does not forecast.
4. **All-or-nothing per asset (point 3) is untouched**, and the nominal veto is read
   BEFORE the missing expenses: a nominal rent is the one refusal declaring the costs
   cannot lift, so «declara tus gastos y contará» would be a promise the engine will not
   keep.
5. **No `payout` is materialized.** Occurrences are still derived to today and only to
   today (ADR 0054 point 4). `isScheduleLiveOn` keeps that job; the rate now goes through
   `isScheduleProjectedOn`, which is the same window plus the declared policy. A rate
   resting on an ended lease says so on its own line — an unannounced projection would be
   the same silence pointing the other way — and the line names WHICH provenance it has:
   «lo has declarado» for an explicit policy, «por el régimen que has declarado» for one
   the regime implies. The report carries the provenance per schedule for that reason;
   telling the owner he declared a renewal he never typed would be a new invention in
   place of the old one.

**Deliberately out of scope.** Computing a legal right: worthline does not derive how
many years of statutory extension are left from a date and a regime — that is a legal
engine with a version and a territory. The regime declares the NATURE of the contract;
if the date on which the decision comes back to the owner is not `end_date`, the owner
declares it. Also out: `renew_with_growth` (a real rent-growth rate is a forecast) and
materializing payouts.

**Consequences.** `payout_schedules` gains the four columns (v66); they travel in the
workspace transfer document, `null` on any document written before v66. The Cobros
surface gains a lease-terms block under each declared rent — the sentence in force plus
the three selects, every one opening on «Sin declarar» — shown only on a property, since
`end_date` on a coupon means what it says. /objetivos gains a `nominal_rent_revision`
notice and names a projection on an applied rate.

## Relationship to ADR 0074

ADR 0074 says the FIRE inputs are the user's declarations, stored in a form that cannot
expire, and that what the app *measures* is a lens, never an input. This decision obeys
it and does not bend it: the rent and its costs are **declarations**, stored with their
own validity window — a non-expiring form. What is derived from them is a rate, exactly
as the reference age is derived from a birth date (ADR 0073). Nothing here is measured
from behavior, and nothing overwrites a declaration: a manual `expectedRealReturn` still
wins over the whole computation, and the panel disappears when it is set, because with a
fixed rate the substitution changes nothing.

## Alternatives considered

- **Add the net rent to the capital instead of changing the rate (rejected — option 1
  of #1414's verdict).** It double-counts: the flat is already in the eligible pool at
  its value, and its rent is what that value produces.
- **Use the gross yield and warn (rejected).** The warning would be the app admitting
  it prints a number it knows is wrong. 6,3 % is not "roughly 4 %".
- **A percentage-of-rent cost field (rejected).** Nobody knows their gastos as a
  percentage; they know the IBI and the community fee in euros. A percentage also
  invites a plausible-looking default, which is how invented figures get sealed.
- **The cost on the holding rather than the schedule (rejected).** It would then have a
  different validity window and a different ownership basis than the rent it nets
  against, and a flat with two rents (a home and a garage) could not split them.
- **Derive from the trailing 12 months of actual payouts instead of the declaration
  (rejected).** A schedule declares a recurrence; a trailing window mixes in unpaid
  months, mid-year rent changes and the property's first partial year, so the rate would
  move for reasons that say nothing about what the flat yields going forward. Exclusions
  (an unpaid month) deliberately do not lower the rate for the same reason.
- **A fine cost breakdown (agency / insurance / IBI / community) — deferred.** One
  amount is what makes the net exist; the breakdown is a budgeting feature and worthline
  is not a budgeting app (ADR 0054).

## Consequences

- `payout_schedules` gains `expenses_minor` (v57, additive, nothing backfilled). It
  travels in the workspace transfer document, defaulting to `null` on a document written
  before v57 — never to 0. It gained the four **lease-term** columns the same way in v66
  (see the amendment above).
- The Cobros surface gains a "Gastos" field on the recurring-payout form and an inline
  "Guardar gastos" control on each declared schedule, so the four rents Jorge entered
  before the field existed can be completed without re-entering them (which would lose
  their exclusions).
- `PayoutSchedule.expensesMinor` is the one exception to "a payout is income-only". It
  is still not a net-worth figure: no wealth total anywhere subtracts it. ~~In
  particular the passive-income lens (#658) stays **gross**~~ **Amended by #1463**: the
  separate decision this bullet deferred was taken — the lens now **nets its trailing
  window** (net headline, gross named beside it when they differ, coverage always on
  net), because coverage decides something and of the gross live the agency, the IBI
  and the insurance before the owner does. The lens' rule differs from the rate's on
  purpose: the rate refuses to derive when expenses are missing (gross would flatter a
  yield); the lens subtracts where declared and reads gross elsewhere (a dividend has
  no hidden cost). Returns and the delta breakdown stay gross — attribution is what
  arrived (ADR 0054).
- The /objetivos FIRE panel gained a disclosure block; the effective-rate line in its
  foot now covers a rate that may be part rung-default and part declared yield.
- The housing rung's 3 % default stays exactly as it was for every property with no
  declared rent — this ADR does not re-price the ladder, it exempts the holdings whose
  income is known.
- **The yield's denominator is the property's value; the pool it compounds is net of
  debt.** The rate rides the ladder's standing convention that tier weights are gross
  and debt only shifts the level (`assembleFireEligiblePool`). That was invisible while
  housing was a flat 3 %; now the substituted figure is explicitly "net rent over
  value", so a mortgaged flat contributes an unleveraged 4,5 % weighted on its full
  value to a pool that counts only its equity. Deliberate, and the conservative
  reading: the leveraged yield on equity would be the higher number, and applying it to
  a net-of-debt pool would compound the leverage twice. Revisit only with a case where
  the simplification misleads — with the mortgage's own cost already modelled by its
  **amortization plan**, netting it here again would be the double count.
- Not covered here: ~~whether the passive-income lens should show net rent~~ (decided
  in #1463 — see the amended bullet above), and whether a rented property with no
  declared expenses deserves a **data-quality signal** rather than only the FIRE
  panel's note.
