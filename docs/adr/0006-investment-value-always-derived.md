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

> **Amended 2026-10-12 (#1828, #1731 review): the pick says where the price comes
> from, and of when.** `deriveInvestmentValuation` returns `priceOrigin` out of the
> SAME selection that valued the holding, so a surface that names the price quotes
> the rule instead of re-deriving it afterwards. There are three origins and only
> three: a provider's cached `quote` (its provider, and `asOf` — the market day the
> provider reported, or the fetch day of a `fresh` row without one), a `manual`
> price (`asOf` from `manual_priced_at`), or `cost` (no price: valued at what it
> cost). «The last operation's price» is not an origin — the live rule never reads
> the ledger's prices, so a hand-set price that equals the last buy is still a
> hand-set price. `asOf` is the day the price is FROM and never anything else: a row
> kept after a failed refresh carries the failed attempt's time, so without a market
> day it has none. `refreshFailed` says the provider's last refresh failed (`stale`
> or `failed` row) whichever origin was picked, so the ficha can say «no se pudo
> actualizar» instead of a bare «cotización Yahoo». `manual_priced_at` is stamped
> on the alta and on every price change since #1828; the v72 rung cleared every
> earlier stamp (it was only ever the alta's), and the workspace document carries the
> stamp as `manualPriceSetAt` so a restore cannot bring an old one back. A hand-set
> price with no stamp says «precio a mano» with no day.

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
