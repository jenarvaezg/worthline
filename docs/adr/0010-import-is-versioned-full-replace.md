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
_export format_: a version **mismatch is rejected** with a clear message, with no migration ladder.
The two layers have different economics — the database migration ladder exists because a user's
live `.sqlite` cannot be recreated and must survive schema evolution in place; an export file, by
contrast, is regenerated on demand from a workspace the user still has, and both ends of the format
are controlled here. Building a format-migration ladder before any second version exists is
speculative (YAGNI). Reject-on-mismatch keeps the importer honest about what it can faithfully load.

The export **omits the audit log**. The audit trail is operational history of _actions_, not the
state of the workspace; a faithful restore of _state_ does not need it, and carrying it bloats the
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

## Amendment (2026-08-28, #1602): the schema IS the contract

The ADR above says the file is validated "schema shape via zod, plus the existing domain
invariants". It did not say **where the shape is declared**, and the implementation answered
that question twice: a tree of hand-written `Exported*` interfaces in `workspace-transfer.ts`
and a mirror tree of zod schemas in `workspace-transfer-parse.ts`, bridged by a bare
`parsed.data as WorkspaceExport`. Adding a field meant editing both, and nothing checked that
they still agreed.

We decided the **zod schemas are the single source**: every `Exported*` type is derived from
its schema with `z.output`, and the parse gate validates against that same schema with no cast.
A field is declared once.

A section that carries a type the domain already owns (`Member`, `Payout`, `NetWorthSnapshot`,
`ManagedPortfolio`, …) keeps its own module as the source of that type — the export contract is
not the right home for `Member`. Instead the schema is **anchored** to it (`reproduces<T>()` in
`schema-anchor.ts`), which makes the compiler require that the schema satisfy the type AND
declare every one of its keys, optional ones included. Vocabularies are anchored the same way
(`vocabularyOf<T>()`), exact in both directions. Anchoring is type machinery only: it is the
identity at runtime and validates nothing the schema does not validate itself.

The direction was chosen over types→zod because the file is untrusted input: the runtime
validator has to exist either way, so deriving the types from it costs nothing, whereas
generating schemas from types needs a build step this repo does not have.

### What the two declarations had already cost

Every one of these was live when the amendment was written, and each is now a regression test:

- the `housing` rung (ADR 0022) was missing from the tier vocabulary, so **no backup of a
  workspace with a home could be re-imported** — the v28 recut freezes that rung onto
  `snapshot_holdings`, so this was real data, not a hypothetical;
- `coingecko` (price provider) and `binance` (price source) were missing, and either one
  brought down the whole document;
- four FIRE declarations (ADR 0078/0081 — `immobilizedCountsAsFireCapital`, `retirementPlan`,
  `ordinaryRetirementAge`, `capitalLastsUntilAge`) were absent from the schema, so zod stripped
  them on **every** round-trip and they came back as the neutral default, silently moving the
  FIRE figures of anyone who had declared otherwise;
- `tierRealReturns` accepted any string key rather than a rung of the ladder.

None of them bumped `EXPORT_VERSION`. The fix widened the validator towards documents this ADR
already promised to accept, and stopped discarding data the file was already carrying; no v3
file changed meaning, so a bump would only have refused the backups already on users' disks.
The version gate itself is unchanged and still runs FIRST, before any structural check.
