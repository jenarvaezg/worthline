Status: ready-for-agent
Title: Housing and debt net worth views

## Parent

.scratch/worthline/PRD.md

## What to build

Add real estate and liabilities as first-class net worth components. Real estate should be modeled as a gross asset and mortgages/debts as separate liabilities. The dashboard should support liquid net worth, housing-inclusive net worth, and gross-assets-versus-debts views.

The completed slice should make it clear how much net worth comes from liquid assets versus property equity and how much debt exists separately.

## Acceptance criteria

- [ ] A user can create a real estate asset with manual valuation, currency, ownership, and illiquid liquidity tier.
- [ ] A user can create a mortgage or debt liability with current balance, currency, ownership, and association to an asset where relevant.
- [ ] Housing-inclusive net worth includes real estate gross value minus associated mortgage/debt.
- [ ] Liquid net worth excludes primary residence and mortgage by default.
- [ ] Gross/debt view shows assets and liabilities separately instead of collapsing them into net values only.
- [ ] The dashboard exposes toggles or segmented controls for liquid, housing-inclusive, and gross/debt views.
- [ ] Tests cover real estate gross value, mortgage liability, ownership allocation, and the three presentation modes.

## Blocked by

- .scratch/worthline/issues/03-manual-liquid-assets-with-ownership.md
