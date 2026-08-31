# The debt service is a witness to the declared spending, never a subtraction

## Context

Worthline models a debt as **stock**: the outstanding balance, netted against the
capital in its own rung (`fire-capital-split`, `rungForLiability`) — the conservative
equivalent of paying the loan off today. What it never modelled is the **flow**: the
cuota, which is the figure somebody actually lives with.

Two surfaces answer "how much can I live on?" in €/month, and neither knew the cuota
existed:

- **Passive-income coverage** (`objetivos-passive-income`) — net payouts ÷ declared
  annual spending. The card prints "**114,9 %** of your declared spending".
- **Sustainable spending** (`fire-sustainable-spending`, ADR 0081) — net rents +
  sellable × withdrawal rate.

`grep -rn "debtService" packages/domain/src` returned nothing, while
`monthly_payment_minor` had been sitting in the database since ADR 0056.

The gap is not the arithmetic; it is that **the same number means two different
things**. Jorge's live cuotas add to ~883,66 €/month against 23.445 € of declared
payouts. His coverage is 114,9 % *if and only if* his declared monthly spending
already includes the mortgage. If it does not, the honest figure is ~63 % — and the
app moves from "you already live off your assets" to "you are a third short" on an
answer nobody had ever been asked for. The field is called «Gasto mensual (€)» and
says nothing about what it contains.

## Decision

**The live debt service is measured and crossed against the declared spending as a
data-quality signal, and the declared spending declares whether it includes it. No
figure changes.**

1. **The declaration has three states.** `monthlySpendingIncludesDebtService` is
   `true` / `false` / absent, and **absent is a first-class state** (ADR 0074): while
   nobody has answered, the engine behaves exactly as before **and both cards say so**.
   A two-state boolean would write "does not include" by omission — inventing the very
   answer this ticket exists to stop asking for silently — and a partial form would
   degrade it to `false` on every save (the `get(field) === "on"` trap). It is read
   through `spendingDebtServiceDeclaration`, never off the field.

2. **The cuota is a reading of the balance curve, not a second simulator.**
   `debtServiceAtDate` resolves which schedule governs today exactly as the balance and
   the accrued interest do (plan vs re-baseline, ADR 0056) and takes the
   `paymentMinor` the cuadro already computed, so a rate revision or an early repayment
   moves it for free (ADR 0090). The three readings now share one
   `resolveAmortizableInput`, so they cannot end up answering about different loans.

3. **Only an amortizable debt has a cuota.** A `revolving` / `informal` liability
   declares a BALANCE on a date and never a schedule: worthline does not know what its
   holder pays monthly, and reading the drop between two anchors as a cuota would
   invent a habit out of two declarations. Absent from the map means "unknown", which
   is not 0.

4. **The witness has the shape ADR 0075 gave the measured savings.** The scope's live
   cuotas — weighted by ownership with the same rule that nets those debts' balances
   against FIRE capital — are crossed against the declaration and emit a signal in two
   cases, and **never enter any arithmetic**:
   - declared spending **includes** the debt service and the cuota does not fit inside
     it → impossible, `high`;
   - **nobody declared** and the cuota is material — at least a quarter of the declared
     spending, the same threshold ADR 0075 uses for a savings divergence — → `medium`,
     "say whether your spending includes the mortgage". Jorge's real case is 44 %, so
     it fires; a 40 €/month consumer loan on 2.000 € of spending moves the reading two
     points and stays quiet.

5. **Subtracting it was considered and rejected.** Making the sustainable spending
   `rents + sellable × rate − debt service` is the most useful shape and the most
   dangerous one: without a maturity date it is a pessimistic figure forever, and with
   one it needs the flow engine ADR 0081 deliberately did not build (his loan ends in
   2032, the mortgage in 2034-05). It reopens **only if** the witness proves the
   declared spending did not include the cuota.

6. **The stock treatment does not move.** The outstanding balance keeps netting against
   the capital in its rung. Subtracting the cuota from the capital as well would be the
   double count the netting already avoids.

7. **A gloss exists only where the cuota exists.** With no live debt service both cards
   are silent: naming an assumption about a debt nobody has is noise, not honesty. The
   wording lives in the domain (`spendingDebtServiceCoverageNote`,
   `spendingDebtServiceSustainableNote`) so the two cards cannot drift into two
   readings of one fact, and the sustainable-spending card says out loud that the cuota
   comes out of that figure and has not been subtracted.

## Alternatives considered

- **Only naming it, with no witness (option 1 alone).** A declaration nobody checks is
  what ADR 0075 was written against. The measurement exists and costs one read per
  amortizable debt.
- **Reading the cuota off `liability_balance_rebaselines.monthly_payment_minor`
  (rejected).** That column is the figure declared or derived *at the re-baseline*; a
  rate revision or an early repayment since then has moved it. The cuadro is the only
  source that stays current.
- **Prorating nothing, as the savings watch does (rejected).** The savings coherence
  compares against a household-level scalar with no share to speak of. A cuota is a
  real cash flow shared with a co-owner, and the FIRE pool already nets those same
  debts by ownership share — half a mortgage is half a cuota.
- **Firing the "declare it" signal for every undeclared config with any debt
  (rejected).** That is a signal for everybody with a mortgage, however small. The
  materiality threshold is what keeps it a question worth interrupting for.
- **Making the declaration a checkbox (rejected).** A checkbox has two states, and here
  the third is the one that matters — see §1.

## Consequences

- New domain seams: `monthlyDebtServiceAtDate` / `debtServiceAtDate`,
  `scopeMonthlyDebtService`, `assessSpendingDebtService`,
  `describeSpendingDebtServiceGap` and the two card glosses.
- `FireScopeConfig` gains `monthlySpendingIncludesDebtService`, carried through the
  workspace export/import (a declared datum with no other source: restoring it as
  `false` would invent an answer).
- The health engine gains a required input (`debtServiceByLiabilityId`) and a
  `spending_coherence` category, mirrored in the agent-view contract, its query enum and
  the assistant's tool schema. Like `savings_coherence` it never headlines the home
  hero: it doubts the two €/month figures on /objetivos, never today's net worth.
- `prepareDashboardState` takes the cuotas as an OPTIONAL input; only /objetivos and the
  two health consumers pay for the reads, and they go through one helper
  (`readMonthlyDebtServiceByLiabilityId`) so a glossed cuota and an alerted cuota are
  the same figure.
- A regression test pins that all three declaration states produce a byte-identical
  sustainable spending, and the page test pins the coverage percentage unchanged. If one
  of them ever moves, the subtraction came in through the back door.
- Not covered: whether the agent view's FIRE context should carry the declaration (an
  agent can still read the coverage without knowing what it means), and the maturity
  dates that option 3 would need.
