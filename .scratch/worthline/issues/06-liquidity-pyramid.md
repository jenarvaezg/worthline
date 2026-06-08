Status: ready-for-agent
Title: Liquidity pyramid

## Parent

.scratch/worthline/PRD.md

## What to build

Add a liquidity pyramid view that groups net worth by liquidity tier. The default view should show net values per tier, and each tier should be expandable to show gross assets and associated liabilities where relevant.

The completed slice should help the user understand how accessible their wealth is, instead of only seeing a single total net worth number.

## Acceptance criteria

- [ ] Assets and liabilities are grouped into configured liquidity tiers.
- [ ] The pyramid shows net value per tier by default for the selected scope.
- [ ] Tiers can be expanded to show gross assets and associated debts where applicable.
- [ ] Housing appears as illiquid/property equity rather than distorting liquid net worth.
- [ ] The visualization works with no data, one tier, and multiple tiers.
- [ ] Tests cover tier grouping, scope allocation, net-by-tier totals, and gross/debt expansion values.

## Blocked by

- .scratch/worthline/issues/04-housing-and-debt-net-worth-views.md
