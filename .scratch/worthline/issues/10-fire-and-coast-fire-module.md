Status: ready-for-agent
Title: FIRE and Coast FIRE module

## Parent

.scratch/worthline/PRD.md

## What to build

Add a FIRE/Coast FIRE module powered by existing net worth data. A user should enter monthly spending, safe withdrawal rate, expected real return, and FIRE asset eligibility. The app should calculate FIRE number, eligible FIRE assets, Coast FIRE required today, percent funded, and estimated Coast FIRE age for the selected scope.

The module should be separate from core net worth totals and exclude primary residence by default.

## Acceptance criteria

- [ ] A user can enter monthly spending for a scope.
- [ ] A user can configure safe withdrawal rate and expected real return.
- [ ] Assets can be marked eligible or ineligible for FIRE calculations.
- [ ] Primary residence is excluded from FIRE assets by default.
- [ ] FIRE number is calculated from annual spending and withdrawal rate.
- [ ] Coast FIRE required today, percent funded, and estimated Coast FIRE age are calculated for the selected scope.
- [ ] The dashboard or module view clearly distinguishes FIRE assets from total net worth.
- [ ] Tests cover household/member scopes, excluded housing, configurable assumptions, FIRE number, Coast FIRE required today, percent funded, and Coast FIRE age.

## Blocked by

- .scratch/worthline/issues/03-manual-liquid-assets-with-ownership.md
- .scratch/worthline/issues/07-investment-operations-and-position-math.md
