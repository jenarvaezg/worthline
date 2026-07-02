# Payouts are attribution records; payout schedules derive past occurrences as truth

## Context

worthline tracks stocks, not flows. A dividend, deposit interest, or rent already
reaches **net worth** today — the cash lands in an account and the next **value
update pass** carries it — but it arrives without attribution: indistinguishable
from salary or spending. Three consumers need that attribution and cannot get it:

- **Returns** (ADR 0040) documents the limit honestly: distributions are not
  modelled, so a distributing fund understates against an accumulating one.
- **FIRE** has no passive-income lens — "how much of my spending do my holdings
  already pay for?" is unanswerable.
- The **delta breakdown** cannot separate recorded income from the savings
  residual.

Nothing about the figures is wrong: the fund's NAV drop on ex-date is already
captured by `units × price`, and the received cash is already captured by the
value update pass. The gap is purely attributional. Meanwhile the recurring cases
(rent, fixed interest) are contractual and tedious to type monthly, and the
product already contains both precedents for recurring declared facts: the
**contribution plan** (ADR 0041), whose occurrences are pending until manually
reconciled, and the **amortization plan** / **appreciation rate**, whose declared
parameters derive history as truth with no per-event confirmation.

## Decision

Introduce the **payout**: a dated record that one asset **holding** paid its
owner an amount — a pure attribution record, never a figure.

1. **Never a figure.** A payout touches no net-worth figure, no holding value, no
   **snapshot**, and no **ripple recalculation** (ADR 0008/0012 untouched). The
   cash keeps arriving exactly as it does today, through the value update pass of
   whatever account received it. worthline does not become double-entry: recording
   a payout moves no balance, and no account is auto-mutated.
2. **Asset-side, income-only.** What a liability charges is already modelled by
   its amortization plan. Costs are not modelled — the user declares the one
   amount they consider theirs (worthline is not a budgeting app, and not a tax
   engine: net or gross is the user's criterion).
3. **Schedules derive truth, following the amortization-plan precedent — not the
   contribution-plan one.** A **payout schedule** (fixed amount, cadence, start,
   optional end, per holding) derives its past occurrences as truth with no
   per-occurrence confirmation. This is safe precisely because a payout is not a
   figure: a stale schedule can only overstate a lens, never corrupt net worth or
   history — a different risk class from contributions, whose reconciliation
   creates real operations and therefore stays manual (ADR 0041).
4. **Derivation, not materialization.** Occurrences are derived from the schedule
   on read, never stored: a retroactive end date removes a dead tail in one edit
   (the "absent six months while the rent had ended" repair), and a per-occurrence
   **exclusion** stored on the schedule removes a single unpaid month.
   Nothing is derived beyond today — expected future income is forecast, the
   contribution-plan family's territory, and out of scope here.
5. **Variable amounts never get a schedule.** A varying dividend is entered as
   one-off payouts; deriving an estimated amount would invent facts.
6. **Consumers read, never write.** The return engine (ADR 0040) accepts a
   declared-payout series — entering the money-weighted cashflows and the realized
   **simple gain** — the passive-income lens reads trailing payouts against
   declared spending, and the **delta breakdown** carves recorded payouts out of
   its residual. **Export/import** carries payouts, schedules, and exclusions like
   any workspace fact (ADR 0010/0015).

## Considered options

- **Attribution-only records with truth-deriving schedules (chosen).** The full
  attribution gap closes with zero contact with the figure/snapshot machinery,
  and the recurring 90% case (rent) costs one declaration.
- **Payouts that move cash (double entry).** Rejected: which account, what if the
  balance was already updated, double-counting — a bookkeeping engine through the
  back door, and the budgeting slope worthline has rejected repeatedly.
- **Pending-until-reconciled occurrences (the contribution-plan shape).** Rejected:
  12 confirmations a year of a contractual fact, imposed to guard against a risk
  (figure corruption) that attribution-only records do not carry.
- **One-off payouts only, no schedules.** Rejected as the default UX for the most
  common real case: rent and fixed interest are contractual recurrences; typing
  them monthly is friction without an honesty gain.

## Consequences

- `CONTEXT.md` gains **payout** and **payout schedule** (UI: "Cobro" / "Cobro
  recurrente"); **return**'s honest-limits language changes to "distributions
  enter only as declared payouts".
- The return engine's input contract (#547) gains an optional payout series;
  shipping order is independent — without payouts the documented limit stands.
- The passive-income lens ("renta pasiva") and the delta breakdown's payout band
  are downstream consumers, each in its own PRD.
- A payout deletes directly with confirmation (small and re-enterable, the
  operation precedent) — no trash.
- The forecast twin ("expected income" for FIRE what-ifs) is explicitly deferred
  to the contribution-plan family and must not be built here.
