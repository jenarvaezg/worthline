# The cuadro is a reading of the balance curve

- Status: accepted
- Date: 2026-08-26
- Issue: #1596

## Context

ADR 0019 decided WHAT an amortizable debt's curve is: a two-date French schedule
whose boundaries are dated from the first payment, flat across the
disbursement→first-payment stub. ADR 0031 added how the balance moves BETWEEN two
boundaries (step or interpolated), ADR 0056 which schedule governs a date when a
balance re-baseline exists, and ADR 0071 how a bank's own cuadro is read as
events written over an existing plan.

None of them said where the **rows** come from. So `amortization.ts` grew two
French simulators:

- `computeBoundaries` — the hot path. Memoised by the loan's value-key (#158)
  because the historical ripple values one date per past boundary per scope, and
  rebuilding the O(termMonths) big.js schedule per call made saving a long plan
  take ~30 s. It produced only balances; every interest/principal split it
  computed on the way was discarded.
- `amortizationScheduleTrace` — the cuadro the owner and the agent read (#1049).
  Having no split to read, it replayed the whole schedule: same payment recomputed
  at every rate revision and every `reduce-payment` lump, same lumps applied
  before the month's amortization but never backdated to the boundary (#1291),
  ending in a comment that said it "mirrors `computeBoundaries` step for step".

They agreed, and they were kept in step BY HAND. The invariant that mattered — a
period closes at the balance the curve reports on that date — was pinned only by
tests that ran both engines and compared. Both #1291 (a lump backdating itself to
the previous cuota) and #1049 had to land twice; the third such fix, on a lump, a
rate revision or a short stub, would have been the one that landed once and left
the cuadro and the ficha disagreeing about the same debt.

The owner sees **one** number for a debt. A cuadro that can drift from the ficha
is not a second view of it; it is a second opinion about it.

## Decision

The cuadro is a **reading of the curve**, not a model of it. `computeBoundaries`
keeps the interest/principal split of each payment cycle it already computes, and
`amortizationScheduleTrace` projects those rows. There is one French simulator.

- **A period's closing balance IS a boundary**, not a recomputation of one. Row
  `p` reports `boundaries[p]`, the same value `amortizableBalanceAtDate` reads on
  `boundaryDate(p)` — so the two agree by construction, and no test is what holds
  them together.
- **What stays on the cuadro's side moves no figure**: which row a dated event is
  listed on (`eventsByPeriodFor`, the #1291 rule that an event rides the period
  whose figures it moves), and where the table stops (the first row closing at
  zero, so a `reduce-term` payoff ends it early). Presentation, not arithmetic.
- **The split is rounded to the cent when recorded, not when read.** It rides the
  memoised curve, and precision is not free here: the balance gains ~20 decimals
  per month, so a 480-cuota loan's tail Bigs run to ~9.600 digits. Retaining four
  more of those per month would multiply what a cached curve holds by five, for
  figures the cuadro rounds at the edge anyway. The rounding is the reader's own,
  so every row is byte-identical to the replay's — differing only in where the
  table ends, which the replay had wrong (see Consequences).
- **The cuadro remains a diagnostic READ, and the trade is measured.** Both
  engines in one process on a 480-cuota loan (differential A/B, three alternating
  rounds): the ripple's warm path is unchanged (8.000 balance queries, 155–182 ms
  before against 89–165 ms after), a cold curve build costs ~5 % more (the four
  roundings per month, paid once per loan and then amortised over every date the
  ripple asks for), and the cuadro itself goes from 7,9–10,3 s to 92–128 ms per
  50 reads — ~65× — because it now goes through the memo instead of rebuilding
  the curve. That last one is what the ficha's settlement estimate (#1292) was
  paying on every call.

## Consequences

- A fix to a lump, a rate revision or a stub lands once. The cuadro cannot fail
  to reflect it, because it has nothing of its own to fix.
- One figure moved, and it was the replay that was wrong. It decided where the
  table ended by looking at the NEXT boundary's balance rather than the row's own
  closing, so a lump that cancelled the loan ON a boundary produced one extra
  row: a full cuota charged on a balance already at zero, dated a month after the
  debt was gone. Reading the curve ends the table on the cuota that closes the
  loan, which is what the code already documented and what the early-repayment
  simulation's end date and the settlement estimate (which returns "no running
  cycle" instead of a zeroed one) both wanted.
- A comment saying a function "mirrors the boundary curve" is a defect report: it
  means the second simulator came back.
- `firstCuota` stays separate and stays a display figure. The real first payment
  of a long stub carries the stub's day-count interest (ADR 0019) while row 1
  carries the ordinary month's; the stub never moves the curve, so the cuadro
  reports the curve's arithmetic and the surface names the charged cuota beside
  it. Two figures, one engine, and the difference is exactly the stub interest.
- The last row of a `reduce-term` loan still shows the full cuota while retiring
  only the principal that was left, so it does not add up on its own. That is a
  separate reading problem — the row exists and its cuota is real, it is just
  partial — and it is untouched here, now pinned by a test that says so rather
  than left as an accident nobody had looked at.
- The quadratic precision growth of the balance (~222 ms to build a 40-year curve
  cold) is unchanged and still there. Capping it would move every figure in every
  historical snapshot, so it is a decision of its own, not a side effect of this
  one.
- The schedule import (ADR 0071) is unaffected: it reads a bank's document into
  events and never simulated the francesa. It remains the only other thing
  called a cuadro, and CONTEXT.md now distinguishes the two.
