# A contribution ceiling is declared, and what it has spent is derived

## Context

In the middle of a long conversation about FIRE, Jorge asked for one concrete,
actionable thing:

> «A fecha de hoy llevo aportados a PP 1.300 € de los 1.500 posibles. **Es lo que quiero
> editar.**»

He wants a counter of annual allowance consumed: *how much have I put into pension plans
this year, and how much is left before I go over the ceiling*.

Neither half of that sentence existed. The **contribution plan** (ADR 0041) models
forward intention — cadence, amount, destination, start and end — and has no notion of a
per-calendar-year ceiling, in the plan or in `FireScopeConfig`. And the destination of
his single plan row *is* a pension plan, so the "how much so far" is already in the
system, spread between reconciled occurrences and the holding's real operations. What
was missing was the ceiling to compare against, and the subtraction.

The ceiling is where this gets interesting. The Spanish pension-plan limit depends on
the year's legislation, on whether there are employer contributions, on the
contributor's earned income, and on more. Encoding it would be **tax advice**, a **rule
that expires on its own** with nobody left to remember to update it, and **one
jurisdiction's number** inside an app that is already multi-currency.

The consumed side has the mirror-image trap. Counting only the plan occurrences marked
`fulfilled` would be easy — the reconciliation store is right there — and it would make
the counter lie downwards, because Jorge contributes off-plan too. A counter that reads
low is worse than no counter: it invites you to overshoot believing there is room left.

## Decision

**The ceiling is the user's datum and never a rule in the code. What has been spent
against it is derived from the operation ledger and never typed, and never read off the
plan.**

1. **A cupo is an entity whose destinations are the pension plans.** `contribution_allowances`
   (schema v58) carries a label and one amount — `annual_cap_minor`. The holdings that
   consume it are every `pension_plan` with an operation ledger in the scope (live and
   in the trash), derived on read from the **instrument**, never ticked by hand (#1567).
   `contribution_allowance_holdings` remains a last-saved snapshot for export; usage
   always re-derives, so a plan given of alta after the last save still counts. A set,
   not one holding: a tax ceiling belongs to the *contributor* and aggregates every
   plan he holds.

2. **The label is neutral.** "Tope anual de aportación", never "límite de aportación a
   planes de pensiones (España)". The screen says explicitly that worthline does not
   compute fiscal limits and points the user at the official source. If help filling it
   in is ever wanted, that help is a link, not a number in this repo.

3. **Consumed = real buy operations of the calendar year, to those pension plans.**
   Not occurrences, not `fulfilled` flags, not `storedExecutionMinor`, not an
   **apertura** (`source: "opening"` — #1567, #1504): a contribution made without a
   plan row foreseeing it counts, because it happened; a position declared as already
   owned does not. There is no stored total — `computeContributionAllowanceUsage`
   derives it on every read, so a corrected operation moves the counter with it and
   nothing can go stale behind the user's back. The apertura predicate is shared with
   measured savings (`isDeclaredOpening`).

4. **A sell gives no room back.** Only buys count. Pulling money out of a pension plan
   does not restore the room to put it in; netting the two would print contribution
   capacity that does not exist — the flattering direction again.

5. **The money rule is shared, not re-spelt.** One buy's contribution is
   `buyCashOutMinor` — units × price **plus fees** — the same function the contribution
   reconciliation uses for an occurrence's executed amount. Two panels on the same page
   print figures about the same purchase; two spellings of the arithmetic is how a
   screen ends up disagreeing with itself.

6. **Only pension plans with an operation ledger consume the cupo.** A stored-value
   destination records no entries one by one; a fund can keep a ledger and still not be
   a contribution to the ceiling (#1567). The form no longer offers a picker; the store
   enforces `consumesContributionAllowance` at the door, so no other writer can get
   around it.

7. **A marked holding's entries count in full, unweighted by ownership.** The
   ceiling belongs to the *contributor*, and what consumes it is what he paid in —
   not his share of what the plan is worth. A jointly-held destination therefore
   consumes the cap with its whole ledger, which is the honest reading and the
   conservative one; the alternative would quote a contribution nobody made.

8. **The calendar year, with no way to configure it.** Until a case appears that needs a
   fiscal year that is not the natural one, offering the choice is offering a decision
   nobody has to make.

9. **The counter is auditable.** Each cupo unfolds into the exact operations it added
   up, dated and named (ADR 0077), and says out loud what it left out — destinations it
   cannot see, operations denominated in another currency (#1401).

## Alternatives considered

- **Encode the Spanish limit and update it yearly (rejected).** Tax advice, expiring on
  its own, jurisdiction-specific. The three debts named in the context.
- **A second typed field for "consumed" (rejected).** The datum already exists in the
  ledger; asking for it again creates two figures that can disagree, and the typed one
  would be the one that rots.
- **Count only reconciled plan occurrences (rejected).** It is the failure this feature
  exists to prevent: Jorge contributes off-plan, so the counter would read low exactly
  when reading low is dangerous.
- **A per-holding ceiling (rejected).** Correct for his single plan today, wrong for the
  model, and a migration the day he opens a second one.
- **A user-ticked destination set (superseded by #1567).** v1 asked which holdings
  consume the cupo. The selector was misread as a fact (#1483) and was the palanca that
  let an apertura eat the year's ceiling (#1504). Destinations are now the pension
  plans, derived from the instrument.
- **Warn when the ceiling is exceeded (deferred).** Going over has real consequences,
  but the notice belongs with the rest of the data-quality signals (PRD #654), not as an
  alert bolted onto this panel. v1 is the counter and its bar. For the same reason there
  is no "almost there" tone either: a 90 % threshold is a number nobody declared, and a
  colour on its own says nothing the printed line does not say better.
- **Stored-value destinations (deferred).** Their only record of a real entry is the
  reconciliation receipt, which exists only where a plan row exists — the
  count-the-intention trap wearing a different hat. Left out rather than counted wrong.

## Consequences

- `contribution_allowances` + `contribution_allowance_holdings` (v58, additive; nothing
  backfilled — a workspace with no cupo pays no read).
- /objetivos gains a "Cupo anual de aportación" panel next to the contribution plan:
  the figure, a bar whose tone rises from neutral to gold to the debit rule as the
  ceiling approaches and is passed, the audit fold, and the editor (name + cap; no
  destination picker).
- The bar's colour is never the only signal: the printed line says "quedan X" or "te has
  pasado X".
- The FIRE projection is untouched. A cupo is not a figure the math reads — it is a
  ceiling on a flow, in the same family as the contribution plan (ADR 0041) and equally
  outside net worth and snapshots.
- Not covered here: the data-quality signal for an exceeded cupo, stored-value
  destinations, and any notion of a fiscal year that is not the calendar year.
