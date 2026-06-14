# Amortization plans carry a disbursement date and a first-payment date

An **amortization plan** (ADR 0014, PRD #109) declared a single `start_date`. The
French-schedule engine treats it as the start of the first monthly period: the
balance is the initial capital up to that date, the first payment falls exactly
one month later, and every payment lands on that date's day-of-month.

Real mortgages don't work that way. They **disburse** (firma / devengo) on one
day — often mid-month — and make the **first payment** on a fixed day (the 1st,
for ING) after a stub period that is **longer than one month**. The first cuota
carries the stub interest (interest for that longer opening period), then
payments settle into the regular schedule. One date can't express both the day
the debt appears and the day/anchor of the payment schedule — so `start_date`
conflated them, with an off-by-one (`first payment = start + 1 month`) on top.

The cost was a **silent balance drift**, not a visible error. A clean fixed-rate
mortgage with otherwise-correct plan numbers had its `start_date` set to the
firma (mid-month). The engine then scheduled payments on that day-of-month and
began amortizing ~1,5 months early, running the modeled balance hundreds of euros
**below** reality across two years. A second mortgage matched its bank table only
because its `start_date` had been hand-aligned to the payment day when its plan
was built. Nothing flagged the drift; it surfaced only when the balances were
reconciled month-by-month against the bank's table.

## Decision

An amortization plan carries **two dates** instead of one:

- **disbursement date** (firma / devengo) — when the debt **exists** at its
  initial capital and interest begins to accrue. This is when it enters the
  portfolio: the historical ripple (ADR 0012) generates/recalculates the debt
  from this date, so it appears alongside the asset it financed ("la hipoteca
  empieza con la vivienda").
- **first-payment date** — the first cuota. The balance starts amortizing here,
  and this date's **day-of-month** is the recurring payment day; subsequent
  payments fall on that day each month. The term counts payments from here.

Between disbursement and first payment the balance is flat at the initial
capital.

## The stub is cosmetic for balances

The stub interest (disbursement → first payment, more than a month) does **not**
move the balance curve: the principal amortized by the first payment is the
ordinary French principal for that period; the stub only enlarges the displayed
first **cuota**. So snapshots and net worth need only the two dates. The exact
first cuota is presentation — derived on demand as
`capital × rate × days(disbursement → first payment) / 360` — never a separate
schedule entry, and never a thing the balance math reads.

## Form: capture both, suggest the second

The form captures both dates. The first-payment date is **pre-filled with a
suggestion** (the 1st of the month roughly two months after disbursement — the
"rest of this month plus a full month" stub ING uses) that the user can edit. The
suggestion is a convenience, not the model: banks vary (one- vs two-month stubs,
payment days other than the 1st), and baking the assumption in as the only
behaviour would silently mis-model the exceptions — the exact failure mode this
ADR exists to kill. The disbursement date has no default; it's on the deed.

## Migration

Existing plans have one `start_date`. Backfill **disbursement_date = start_date**
and **first_payment_date = start_date + 1 month**: this reproduces today's curve
exactly (the engine's current "first payment one month after start" rule), so the
migration changes no figures. It preserves _behaviour_, not necessarily _reality_
— a plan whose `start_date` was the firma still mis-models until its two real
dates are re-entered. Re-ripple each amortizable debt after migration. (The
affected debts were already corrected by hand against their bank tables.)

## Considered options

- **Single date = first payment, infer disbursement** — rejected: it loses when
  the debt appears. The debt must show from the firma, beside the asset it
  financed; the first-payment date can't supply that.
- **Assume the first payment from the disbursement, with no field** (the
  "30 days + rest of the contracting month" heuristic) — rejected as the _model_.
  It happens to fit both ING cases here, but it is not universal, and a wrong
  guess mis-models silently and untraceably. Kept only as the editable default.
- **Model the stub as an explicit first period** (a real short/long opening
  entry) — rejected as unnecessary: it doesn't affect balances, so it earns its
  place only as a derived display of the first cuota, not as schedule state.
- **Leave `start_date` and document the convention** — rejected: the off-by-one
  workaround (`start = first_payment − 1 month`) plus a separate patch for the
  firma snapshot is exactly the hand-tuning that let the drift hide.

## Consequences

- The amortization-plan ripple keys off both dates: the debt is valued at its
  initial capital from the disbursement date, payment boundaries run from the
  first-payment date on its day-of-month, and the snapshot at disbursement
  carries the full capital.
- The whole class of "fixed-rate mortgage I didn't touch drifts in the past" bugs
  is fixed at the model level, with no per-loan hand-alignment.
- CONTEXT.md's **Amortization plan** definition is updated to name both dates.
- `start_date` is replaced, not supplemented; there is no third "schedule anchor"
  concept to reason about.
