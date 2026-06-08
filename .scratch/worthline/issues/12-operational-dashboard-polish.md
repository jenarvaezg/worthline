Status: ready-for-human
Title: Operational dashboard polish

## Parent

.scratch/worthline/PRD.md

## What to build

Refine the final MVP dashboard into a polished operational finance interface. The dashboard should be dense, sober, precise, responsive, and visually distinct from generic AI dashboard aesthetics. It should bring together net worth summaries, scope switching, liquidity pyramid, snapshots, positions, warnings, and FIRE into a cohesive daily-use experience.

This is marked HITL because the visual quality bar and product feel require human review.

## Acceptance criteria

- [ ] The first screen is the working dashboard, not a landing page or marketing page.
- [ ] The dashboard clearly shows liquid net worth, housing-inclusive net worth, gross assets, debts, selected scope, and recent changes.
- [ ] Positions, balances, warnings, price freshness, snapshots, and FIRE are organized for repeated scanning rather than one-off presentation.
- [ ] The visual design is polished, compact, and not a generic AI/SaaS dashboard.
- [ ] Responsive layouts work on desktop and mobile-width screens without text overlap or broken controls.
- [ ] Controls use appropriate UI affordances such as segmented controls, toggles, icon buttons, tables, and compact charts.
- [ ] Visual regressions are checked with screenshots or equivalent browser verification once the UI exists.
- [ ] Remaining UX gaps are documented as follow-up issues rather than silently hidden.

## Blocked by

- .scratch/worthline/issues/05-snapshots-and-monthly-closes.md
- .scratch/worthline/issues/06-liquidity-pyramid.md
- .scratch/worthline/issues/10-fire-and-coast-fire-module.md
- .scratch/worthline/issues/11-warnings-overrides-audit-log-and-soft-delete.md
