Status: ready-for-agent
Title: Investment operations and position math

## Parent

.scratch/worthline/PRD.md

## What to build

Add unit-based assets and simple investment operations. A user should be able to create listed investments, crypto, funds, or physical assets that use quantities, then record buys and sells with date, units, price, currency, and fees. The app should derive current units, weighted average cost, simple unrealized P/L, and show positions in the dashboard.

This slice should remain tax-agnostic and avoid FIFO/LIFO fiscal behavior.

## Acceptance criteria

- [ ] A user can create a unit-based asset with ticker/ISIN/provider symbol fields where applicable and manual fallback valuation.
- [ ] A user can record buy and sell operations with date, units, price, currency, and optional fees.
- [ ] The domain layer derives current units from operations.
- [ ] Weighted average cost is calculated for remaining units.
- [ ] Simple unrealized P/L is shown when current valuation is available.
- [ ] Selling more units than recorded is treated as an overrideable warning, not an unhandled failure.
- [ ] Position rows appear in the dashboard or positions table for the selected scope.
- [ ] Tests cover buys, sells, fees, weighted average cost, unit precision, P/L, and warning behavior.

## Blocked by

- .scratch/worthline/issues/03-manual-liquid-assets-with-ownership.md
