# An investment's value is always derived, never edited by hand

> **Amended 2026-07-31 (#1330): zero is not a price.** When a fetch fails with no
> prior good price, the pool writes a marker row `{ price: "0", freshness_state:
> "failed" }` — a record of the failure, not a quote. The valuation read consumed
> it and answered `units × 0 = 0 €`, defeating the cost-basis fallback #1314 had
> established for "no row at all". The price-selection rule now skips any
> non-positive or malformed figure (cached AND manual), and `usableCachedPrice`
> (`packages/domain/src/prices.ts`) is the single place that decides whether a
> cache row is a price at all: every reader that would multiply, divide or
> attribute by it asks there. A holding whose only row is a failure is valued at
> cost, and the row stays in the table for the freshness and salud-de-datos
> surfaces, which need its state and `stale_reason`.

Investment assets appeared in two tables at once: the ledger, where their
`currentValue` was manually editable like any other asset, and the positions table,
where their value derives from units held × unit price. Two write paths to one
figure meant the manually typed value and the derived one could silently disagree.
We decided the derived figure is the only one: an investment's value is always
units × price, the manual valuation path is removed for investments, and the unified
portfolio list shows investment rows as read-only, linking to the investment's own
detail (positions, operations, prices).

We considered keeping both views with the ledger row merely demoted to read-only
display of the typed value, but that preserves the stale-value hazard; and keeping
investments out of the portfolio list entirely, but then no single list answers
"what do I own?".

## Consequences

- The only ways to move an investment's value are recording an **operation**
  (changes units) or a price change (provider fetch or manual quote) — the manual
  quote is a price, not a valuation.
- `updateAssetValuation` must reject (or never be offered for) investment assets.
- Net worth, liquidity breakdown, and snapshots must read investment values through
  the derived path so every figure agrees with the positions table.
