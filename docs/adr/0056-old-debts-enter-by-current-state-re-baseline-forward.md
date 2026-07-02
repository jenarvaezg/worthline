# Old debts enter by current state; amortized plans re-baseline forward

## Context

An **amortization plan** is declared from its original conditions — initial
capital, rate, term, disbursement and first-payment dates (ADR 0019) — and
derives every balance from there. That works for a debt signed recently. It
collapses for the debt most real households actually carry: a variable mortgage
signed decades ago. The first real external user's case: signed 2004, ends 2032,
~two decades of Euribor **interest rate revisions** and several **early
repayments**. Reconstructing that plan means typing ~30 revisions from old bank
letters; skipping them means the derived balance is confidently wrong. His
verdict: "esa no va a funcionar — por lo menos que me deje meter el valor".

What the user reliably knows about an old debt is its *current state*: the
outstanding balance today, the end date, and the current payment (or rate). The
add-holding wizard already applied this "no wall" philosophy to property; debts
never got it. The same gap appears later in a debt's life: a modelled balance
that has drifted from the bank's reality has today no honest repair short of
re-entering the plan.

## Decision

1. **A debt may be declared by current state**: outstanding balance today, end
   date, and current annual rate _or_ current payment. Term is the months to the
   end date; the French schedule amortizes **forward only** from the declared
   balance. Given the rate the payment is derived, and given the payment the
   rate is solved — and the derived one is shown back as an **honesty check**
   ("con estos datos tu cuota sale X €/mes — ¿cuadra?") before saving.
2. **The unmodelled past stays unmodelled.** The original signing date is
   optional metadata; the years before the baseline are never reconstructed,
   backfilled, or estimated. History for that debt starts at its baseline date.
3. **The same mechanism recalibrates an existing amortized debt**: a **balance
   re-baseline** — a declared outstanding balance at a date — re-derives the
   schedule forward from that date. It is a dated fact: it ripples from its date
   forward (ADR 0012) and never rewrites what came before. This is also the
   repair for the "mortgage drift" the financial assistant can warn about but
   until now could not fix.
4. **No new valuation method.** The debt stays **amortized** — cuota semantics,
   payoff projection, future revisions and early repayments all work unchanged
   from the baseline forward. A re-baseline is not a **balance anchor** (the
   anchored methods' concept): it keeps the schedule.

## Considered options

- **Current-state entry + re-baseline over the amortized model (chosen).** Keeps
  every amortized feature, adds one declared fact, honest about the past.
- **Model old debts as anchored (balance anchors).** Rejected: loses cuota
  semantics, payoff projection, and the end-date truth — exactly what makes a
  mortgage worth having in the app.
- **Demand original conditions plus full revision history.** Rejected by
  reality: the data is unrecoverable from decades of bank letters, and a
  confidently wrong balance is worse than an honest baseline.
- **Estimate the missing history (average rates, interpolation).** Rejected:
  invented facts in a product whose spine is declared truth.

## Consequences

- `CONTEXT.md` gains **balance re-baseline** (UI: "Recalibrar con saldo real" /
  entry mode "Alta por estado actual") and the **amortization plan** entry
  documents the current-state entry mode.
- ADR 0019's two-date rule is untouched for debts declared from origin; a
  baseline debt's disbursement-equivalent is its baseline date.
- A re-baseline is a stored dated fact on the liability (audit-trailed like any
  other), rippling forward from its date.
- Snapshots before a debt's baseline date simply do not include it — the honest
  reading of "history starts when truth starts".
- The wizard's debt drawer and the advanced edit surface both offer the
  current-state mode; the recalibrate action lives on the existing debt's
  editing surface.
