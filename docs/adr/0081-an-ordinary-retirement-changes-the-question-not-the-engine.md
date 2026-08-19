# ADR 0081 — An ordinary retirement changes the question, not the engine

- Status: accepted
- Date: 2026-08-19
- Issue: #1428 (with #1414, #1416, #1447, #1448, #1460)
- Supersedes / amends: nothing. Extends ADR 0074 (FIRE inputs are user declarations)
  and ADR 0078 (immobilized capital counts unless the user says otherwise).

## Context

Jorge is 63. He retires at 67, he will draw a public pension, and his share of four
rented flats already pays ~1.957 €/month against 2.000 €/month of declared spending.
The /objetivos screen told him he was **31,5 % short** and would get there **at 73**.

Both figures were correct. Both were useless, because **this man is not doing FIRE** —
and does not need to.

The tempting fix is to teach the engine about his life: public pension with a start
date, rents with their own dates, a mortgage that ends, a deficit that varies by
stage. Three reasons say no, and they are independent:

1. **Scope.** FIRE is *Financial Independence, **Retire Early***. An engine with
   accrual dates and a per-stage deficit is not a FIRE calculator, it is a
   **retirement cash-flow planner** — a different product.
2. **The formula changes nature.** A safe withdrawal rate is a rule for a portfolio
   that must last 30–40 years with no income. With a pension at 67 the real problem is
   bridging four years. That is not "subtract the pension from the spending"; the whole
   formula stops applying.
3. **The sum would not add up.** The engine already consumes *spending* (the target)
   and *savings* (the speed), and savings is the residue of income minus expenses. A
   pension or a rent added as a third input counts the same money twice. The repo
   already models this: ADR 0054 keeps a payout out of every net-worth figure, and the
   FIRE answer for recurring income was a **lens** (`objetivos-passive-income.ts`,
   #658), never an engine input.

But refusing to re-model the engine cannot mean going on handing him a number that
does not serve him.

## Decision

**Detect the profile, offer the swap, and change the question — not the engine.**

1. **A copy layer, not a mode.** Same screen, same figures, different headline plus one
   card. A full "retirement mode" is the door to the cash-flow planner we just decided
   not to build.

2. **`FireScopeConfig.retirementPlan`** carries the user's declaration: `"ordinary"`,
   `"early"`, or absent. It moves no figure — only which question leads the screen.

3. **Detect and OFFER, never impose.** Signals propose; the declaration decides, in
   both directions (a "no" has to be stored, or the offer would come back on every
   load). Reversible from the assumptions form. Two v1 signals, and each reads a
   **declared** datum, never an engine fallback:
   - `target_age_is_ordinary`: the declared target retirement age is at or above
     `ordinaryRetirementAge` (a user datum with a neutral default of 65 — never
     legislation in code, same doctrine as the contribution cap of #1427). Reading the
     engine's `?? 65` fallback here would tell every user who never touched the field
     that their plan looks like an ordinary retirement, quoting an age they never
     typed. A default is not a declaration (ADR 0074).

     **This forced a change at the source.** `parseFireConfigFormStrict` used to write
     `targetRetirementAge: ?? 65` unconditionally, so every stored config carried a 65
     nobody chose — and with the threshold's own default at 65, guarding on
     "is it declared?" bought nothing: the offer fired for everyone. The field is now
     genuinely optional end to end (blank input, `65` as a watermark, absent from the
     command when blank), and the engine keeps its `?? 65` where it has to compute. The
     same trap is closed one line down: the final age is validated against the
     *declared* target age only, never against the fallback.
   - `regular_unreachable`: the Regular level never crosses inside the projection
     horizon — read off the level rail the screen already computed, not a second
     trajectory. Requires a declared savings capacity, for the same reason: with none,
     "your savings never get you there" talks about a blank field, not about a plan.

4. **The answer for that profile is the inverse of the FIRE formula**, computed from
   the same inputs and no new engine: `sustainable spending = capital × withdrawal
   rate`. It is presented **split in two halves**, and the split is what makes it
   honest:
   - **Net rents**, as decided by ADR 0076 (net or nothing) and already scaled to what
     the scope owns. Deliberately independent of the immobilized declaration (ADR
     0078): a flat the user will never sell is not FIRE capital, and its rent still
     arrives every month.
   - **What the SELLABLE capital supports** (#1447). The immobilized side is never in
     this figure — a withdrawal rate assumes capital sold in slices — so the card names
     the brick it leaves out instead of letting a reader assume it is inside.

5. **Two versions of the answer, because there are two.** *Perpetual*
   (`sellable × rate`, never touching the principal) and *depleting* (the same capital
   annuitized to a final age). The depleting one is the honest question for an ordinary
   retirement — that profile does not need to preserve the principal forever — and it
   needs a **final age, which is a user field with no default applied**: without it the
   card shows the perpetual half alone. No actuarial table enters the model; the FIRE
   engine is pure SWR and the duration rides inside the choice of rate.

   The field is `capitalLastsUntilAge`, deliberately NOT `lifeExpectancyAge`: naming it
   after a life expectancy would claim exactly the estimate this ADR refuses to make.
   The neutral 90 the issue asks for lives where it belongs — as the form's watermark,
   visible without becoming a value nobody typed.

   Two clocks would be worse than one: the horizon is measured from **today's**
   reference age, not from the retirement age, because both figures describe today's
   capital. Annuitizing today's balance over a window that starts at a future
   retirement would spend money that window assumes has already grown.

   When there is no depleting figure, the card says which datum is missing — the final
   age, the birth date the reference age comes from, or neither (a final age already
   reached). Asking again for a field the user has already filled reads as not
   listening.

6. **The funded percentage is not deleted.** It stays printed and stays true; it stops
   being the headline when the headline does not apply.

## Consequences

- `fireRetirementProfile` and `fireSustainableSpending` are pure domain modules with no
  new formula: the profile reads the rail the screen already has, and the spending
  divides the capital `calculateFireForScope` already resolved.
- `FireRentReturnReport` gains `netRentAnnualMinor` — the income half, from the same
  door that decided the rate, so the two cannot disagree about the same rent.
- The public pension stays out **as an engine input**. If it is ever wanted, the
  compatible route already exists: `baristaMonthlyIncomeMinor` generalises to "recurring
  income that shrinks the capital needed". What is not built is a per-stage deficit
  inside `calculateFire`.
- `get_fire_context` publishes the profile and the sustainable spending, so an
  assistant does not repeat the failure this ADR exists to fix by quoting "you are
  31,5 % short" at someone whose plan is an ordinary retirement.
- The signals are heuristics over user data. They can be wrong, and that is priced in:
  the worst case is an offer the user declines once.
