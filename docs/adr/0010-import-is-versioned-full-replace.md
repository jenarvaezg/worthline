# Import is a versioned, full-workspace replace

The app is local-first with no sync, so its only backup, restore, and move-between-machines
mechanism is a portable file: an **export** is a single versioned JSON document capturing the
whole workspace, and an **import** replaces the current workspace with that file's contents. We
decided an import is a **full atomic replace** — it wipes everything (live data and frozen
history alike, exactly like a reset) and reloads from the file in one transaction, preserving the
original ids so the restored workspace is the same one, not a copy. It never merges with existing
data. If the file fails validation at any point, nothing is touched.

We considered a **merge/upsert** import (blend the file into the current workspace by id). We
rejected it: it serves none of the real use cases (backup/restore and migration both want "make
this machine look exactly like the file"), and it multiplies complexity — id collisions, ownership
splits to reconcile, duplicate snapshots — for a personal MVP. "Pisar" means replace, not blend.

The file carries a `version`. We considered mirroring the database's forward-migration ladder
(ADR 0002) so old export files would be auto-upgraded on import. We chose the opposite for the
*export format*: a version **mismatch is rejected** with a clear message, with no migration ladder.
The two layers have different economics — the database migration ladder exists because a user's
live `.sqlite` cannot be recreated and must survive schema evolution in place; an export file, by
contrast, is regenerated on demand from a workspace the user still has, and both ends of the format
are controlled here. Building a format-migration ladder before any second version exists is
speculative (YAGNI). Reject-on-mismatch keeps the importer honest about what it can faithfully load.

The export **omits the audit log**. The audit trail is operational history of *actions*, not the
state of the workspace; a faithful restore of *state* does not need it, and carrying it bloats the
file. Instead, a successful import writes a single `import_workspace` audit entry, so the restored
workspace's history starts with "imported on X" rather than empty.

## Consequences

- Import and reset share the same erase step; import then repopulates from the file and lands on a
  populated dashboard, whereas reset lands on onboarding.
- Ids are preserved on import, so `snapshot_holdings.holding_id` references and ownership splits
  stay coherent and a restore is the same workspace, not a clone.
- All file sections are optional on import: a script-generated file carrying only live state
  (no snapshots, no trash) imports cleanly, with the absent sections left empty. This is what makes
  pre-populating from an external source possible without the app ever knowing the file's origin.
- The file is untrusted input at a boundary: it is validated in full (schema shape via zod, plus the
  existing domain invariants — ownership totals 100%, money in integer minor units,
  `assertSnapshotHoldingsReconcile`, `assertNotInvestmentAsset`, referential integrity, EUR base
  currency) before any destructive step, and the whole load is one transaction.
- Import has two entry points — onboarding (for a fresh machine or external pre-populate) and the
  settings danger zone (to overwrite an existing workspace) — over one import path. Export lives only
  in settings, since it requires a workspace to exist.
- A future second format version forces a decision then: bump-and-reject, or introduce a converter.
  Until then there is nothing to migrate.
