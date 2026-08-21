# Investment returns are three present-time measures; time-weighted return uses Modified Dietz over monthly closes

## Context

worthline records an **investment**'s **operations** (buy / sell, each with date, units, price per unit, fees) and derives its position in `derivePosition` (`packages/domain/src/positions.ts`) into a `PositionSummary` that already carries `costBasis` and `unrealizedPnl`. But: that summary is **not surfaced** to the agent view; **realized P&L is not computed** (a `sell` updates cost basis proportionally and discards the sale price); and there is **no money-weighted (IRR) or time-weighted (TWR) return** anywhere. An agent inspecting a holding had to compute "+30%" by hand from cost and value.

The data needed exists. Operations are signed cashflows. Snapshots carry each holding's `valueMinor` (plus units / unit price) per date, so a per-holding value series is reconstructable — but only from when snapshots began, and at most one per day (ADR 0005), with the **monthly close** as the clean periodic series. There is **no historical price series** before snapshots (the #459 / #535 wall), so no return can be reconstructed before that point.

## Decision

Report investment performance as **three complementary, present-time, derived measures** — never stored, and (like exposure) not a figure the net-worth math reads:

- **Simple total gain** — `realized + unrealized` P&L in € and as a percentage of cost basis. Not time-aware. Requires adding a **realized-P&L accumulator** to `derivePosition` (proceeds − cost of units sold), so a partly-sold holding is not understated.
- **Money-weighted return (IRR)** — an **XIRR** over the operation cashflows plus the current market value as a final flow at today's date (Newton-Raphson with a bisection fallback; non-convergence returns null with a reason, never a bogus number). The "how am I doing" number — it reflects the investor's own contribution timing — and the **default** return.
- **Time-weighted return (TWR)** — **Modified Dietz chain-linked over monthly closes**: per month `R = (V_end − V_start − ΣcashflowsInMonth) / (V_start + Σ(cashflow × fractionOfMonthRemaining))`, chained `Π(1+R) − 1`. Removes the effect of cashflow timing — the measure comparable to a benchmark.

- **Annualize only for spans ≥ 1 year.** IRR is inherently annual; simple gain and TWR report total over the span and an annualized figure (`CAGR` / `(1+TWR)^(365/days)−1`) only when the span reaches a year. Sub-year is shown as total, flagged "not annualized" — never annualized (it overstates).
- **Granularity v1 = per-holding + portfolio** (portfolio IRR merges all holdings' cashflows into one dated stream; portfolio simple gain sums; portfolio TWR is Modified Dietz over the whole portfolio's monthly value series). Both are **independent of the exposure-profile work**. **Per-asset-class returns is a fast-follow gated on #539 S0** (it reuses that asset-class axis) — kept off this PRD's critical path.
- **Honest limits, surfaced as signals, not hidden.** Dividends / distributions enter **only as declared payouts** (#657, ADR 0054): a recorded **payout** feeds the money-weighted return (IRR) and the realized **simple gain** as a dated inflow, so distributing funds stop understating for the holdings where income is recorded — but a distribution never recorded is still invisible, and **TWR still tracks price only** (a payout is not folded into the monthly-close series). The per-holding caveat switches to say which measures moved. TWR and any time-series figure start at the **first available monthly close / operation**; the reported figure carries that start date and nothing is invented before it.

## Considered options

- **Money-weighted only, or time-weighted only (rejected).** They answer different questions: IRR is the investor's personal outcome (timing included); TWR is the strategy/fund outcome, comparable to an index. A personal net-worth tool wants both — IRR as the everyday "how am I doing", TWR for benchmark comparison (#546).
- **True daily-valued TWR (rejected).** Breaking at every cashflow and valuing the holding at that exact instant is the textbook method, but it needs a valuation at each cashflow date (snapshots may not exist there) and fights the snapshot model. **Modified Dietz over monthly closes** is the pragmatic industry standard for personal portfolios, uses exactly the data worthline has cleanly, and avoids instant valuation; it loses precision only when a large cashflow coincides with a large intra-month move.
- **Unrealized-only simple gain (rejected).** Cheapest (it already exists), but a partly-sold holding would understate; adding realized P&L is small and makes the simple measure honest.
- **Annualizing sub-year periods (rejected).** Extrapolating a 3-month +10% to ~+46%/yr is misleading; sub-year stays total.
- **Per-asset-class returns in v1 (deferred).** It would couple this PRD to #539's critical path. Per-holding + portfolio deliver the core value alone; per-class is cheap once #539's asset-class resolution exists.
- **Modeling distributions on operations (rejected).** A new income cashflow kind on `operations` was the first instinct; instead distributions live as their own **payout** records (ADR 0054) that the engine folds in as inflows (#657) — keeping operations buy/sell-only and payouts a non-figure attribution layer. IRR and realized simple gain now include recorded payouts; folding them into TWR's monthly-close series is the remaining deferred step.

## Consequences

- The agent view stops hand-computing returns: `get_holding_detail` gains a `returns` object and `get_financial_context` a portfolio `returns` block (the three measures), alongside `exposure`.
- `derivePosition` grows a `realizedPnl`; `PositionSummary` carries realized + unrealized. No snapshot, reconciliation, or net-worth change — returns are present-time, derived, non-figure.
- **Builds on** investment operations and the derived-value model (ADR 0006); **leaves untouched** ADR 0008 (snapshot reconciliation). **Pairs with** the benchmark backlog (#546): TWR is the measure that plugs into a benchmark comparison, and that work reuses the exposure profile's tracked-index label (ADR 0039).
- Sliced in PRD #547: **S0** (#548) realized P&L + simple gain + IRR (domain, pure, TDD); **S1** (#549) TWR (Modified Dietz monthly) reading the monthly-close series; **S2** (#550) agent-view returns surface + honest signals; **S3** (#551) dashboard returns surface; **fast-follow** (#552) per-asset-class returns, gated on #539 S0.

## Amendment (#1457): a subperiod Modified Dietz cannot measure breaks the chain, and a class series is aligned by month

A TWR chains factors `(1 + R)`. The chain only carries meaning while every factor stays positive: two negative factors multiply back to a positive, so the product stops preserving even the sign of the loss, and the reported figure can land below −100% — which no return ever is. Real workspace data produced **−188.9%** for renta variable and **−115.6%** for materias primas.

Two rules follow:

- **`1 + R ≤ 0` means the subperiod is not measurable.** Modified Dietz is an approximation that holds while the period's flow is small against the opening value; once the flow dwarfs it, `R` falls below −100% and the approximation is void. The measure is reported as **unavailable with a reason** (`non_measurable_subperiod`, the shape `TwrResult` already had for `zero_denominator`), never multiplied into the chain and shown as a percentage.
- **An asset class's monthly-close series is aligned by calendar month, not unioned by exact date.** Each holding derives its own monthly closes from the snapshot rows it appears in, so two holdings of one class can close the same month on **different days** — one entered mid-month, or the best-effort daily capture skipped a pass for it (#1339). Summing by exact date then makes every such day a partial sum of the class, and the sawtooth turns an ordinary flow into a giant one against an artificially small value. Per month the class series takes the latest close date any holding reports and sums each holding's close for that month, carrying its last known value across a missing month. The carry stops at the holding's last close: past that the holding has **left** the class, and its sell is already in the TWR cashflows, so Modified Dietz reads the step as a flow, not a price move.

- **A holding with no monthly closes contributes nothing to the class TWR — not even its flows.** Series and flows must describe the same set of holdings. An alta from today appears in no capture yet, so letting its purchase in as a flow with no value behind it is the same failure by another route.

The alignment fixes the cause; the `1 + R ≤ 0` guard is the safety net that keeps an impossible figure from ever being published again — for holdings and the portfolio too, not only classes.
