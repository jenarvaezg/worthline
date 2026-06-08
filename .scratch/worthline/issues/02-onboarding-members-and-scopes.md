Status: ready-for-agent
Title: Onboarding, members, and scopes

## Parent

.scratch/worthline/PRD.md

## What to build

Add the first real user setup path: individual or household onboarding, arbitrary N members, EUR base currency, and a scope selector that can show one member or the household/group total. This should be implemented end to end through persistence, domain calculations, API/action layer, UI, and tests.

The completed slice should let a user create a workspace, add members, and switch the dashboard shell between scopes even before assets exist.

## Acceptance criteria

- [ ] A new local workspace can be initialized in individual mode with one member.
- [ ] A new local workspace can be initialized in household mode with multiple members.
- [ ] Members can be created, edited, listed, and soft-disabled only if the current implementation already supports soft delete primitives; otherwise deletion can be deferred to the soft delete slice.
- [ ] EUR is stored as the default base currency for the workspace.
- [ ] The dashboard has a scope selector for household total and each member.
- [ ] The domain layer exposes scope resolution without hardcoding any person names.
- [ ] Tests cover individual scope, household scope, and arbitrary N-member behavior.

## Blocked by

- .scratch/worthline/issues/01-bootstrap-local-web-slice.md
