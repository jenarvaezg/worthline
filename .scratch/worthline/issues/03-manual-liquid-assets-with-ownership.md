Status: ready-for-agent
Title: Manual liquid assets with ownership

## Parent

.scratch/worthline/PRD.md

## What to build

Add manual liquid assets so the app can calculate a real liquid net worth. A user should be able to create cash accounts or manually valued liquid/semi-liquid assets, assign ownership percentages to members, set currency and liquidity tier, update valuation, and see liquid net worth by selected scope.

This is the first slice where the dashboard should show actual money totals.

## Acceptance criteria

- [ ] A user can create a manual asset with name, asset type, currency, current value, liquidity tier, and ownership split.
- [ ] The app stores money precisely without JavaScript floating-point drift.
- [ ] Ownership splits allocate asset value correctly across individual, household, and custom/group scopes.
- [ ] Liquid net worth includes liquid assets and excludes illiquid housing assets.
- [ ] Manual valuation updates change current net worth without mutating historical snapshots.
- [ ] The dashboard shows liquid net worth for the selected scope.
- [ ] Structurally invalid data, such as missing currency or nonexistent owner, is blocked.
- [ ] Tests cover value allocation, ownership percentages, mixed scopes, money precision, and liquidity inclusion.

## Blocked by

- .scratch/worthline/issues/02-onboarding-members-and-scopes.md
