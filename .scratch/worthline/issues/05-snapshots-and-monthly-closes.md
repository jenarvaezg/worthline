Status: ready-for-agent
Title: Snapshots and monthly closes

## Parent

.scratch/worthline/PRD.md

## What to build

Add frozen historical snapshots for net worth. A user should be able to save a snapshot for the current date, mark a snapshot as a monthly close, and view changes versus the previous snapshot and previous monthly close. Current live calculations must remain separate from frozen historical values.

The completed slice should make progress over time visible without relying on mutable recalculation of old data.

## Acceptance criteria

- [ ] A user can save a snapshot of current net worth for the selected scope/date.
- [ ] The app prevents accidental duplicate daily snapshots or handles them with an explicit replace/update flow.
- [ ] A snapshot can be marked as the monthly close for a month.
- [ ] Historical snapshots remain frozen when current manual valuations change later.
- [ ] The dashboard shows change since previous snapshot and change since previous monthly close.
- [ ] A chart or compact historical view displays net worth over time by scope.
- [ ] Snapshot records include enough metadata to show warnings/freshness state when available.
- [ ] Tests cover frozen snapshot behavior, monthly close selection, and delta calculations.

## Blocked by

- .scratch/worthline/issues/04-housing-and-debt-net-worth-views.md
