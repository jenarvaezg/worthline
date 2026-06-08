Status: ready-for-agent
Title: Warnings, overrides, audit log, and soft delete

## Parent

.scratch/worthline/PRD.md

## What to build

Add the safety layer for imperfect local finance data. Most data issues should be warnings with override rather than blockers. Overrides should not require notes, but they must be recorded automatically. Important entities should support soft delete so historical snapshots and auditability are preserved.

The completed slice should make the app forgiving during migration while still leaving a useful trail.

## Acceptance criteria

- [ ] Validation distinguishes blocking structural errors from overrideable warnings.
- [ ] Overrideable warnings can be accepted without entering a note.
- [ ] Accepted overrides are recorded in an audit log with action, timestamp, entity, and warning details.
- [ ] Create, update, delete, and valuation-changing actions write audit entries.
- [ ] Important records use soft delete where deletion would otherwise break history.
- [ ] Deleted records no longer appear in normal current views but remain available for historical/audit purposes.
- [ ] Restore is supported for at least the main soft-deleted entities, or explicitly deferred with recoverable audit data.
- [ ] Tests cover warning overrides, audit entries, soft delete visibility, restore/deleted behavior, and snapshot preservation.

## Blocked by

- .scratch/worthline/issues/03-manual-liquid-assets-with-ownership.md
