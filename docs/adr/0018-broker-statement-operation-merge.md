# Broker statements: per-investment operation merge

> **Partially superseded by [ADR 0055](0055-statements-route-by-isin-across-the-portfolio.md)** (2026-07-02): the single-ISIN entry contract — one file, one chosen investment, reject mixed ISINs — is replaced by portfolio-level ISIN routing with match/create/ignore. The merge-by-date, executed-rows-only, preview-then-confirm, and ripple semantics below remain accepted.

A user can upload a broker's exported order file (a **statement**, e.g. a
MyInvestor orders CSV for one ISIN) against a chosen **investment** to populate
its **operations**. The statement is neither an **Import** (a one-shot
full-workspace replace) nor a **connected source** (a live, read-only API mirror
that owns its holdings): it is a manual, per-investment, file-based feed of
operations. The holding stays a normal investment whose value still derives from
its **price provider** — the statement only owns the buy/sell history.

## Merge by date, never delete

On upload the statement is merged into the asset's operations **by date**:

- a file row whose date matches an existing operation → **overwrite** it (the file
  wins, even though a true re-import is identical);
- a file row with no matching date → **create** it;
- an existing operation whose date is **absent** from the file → **left
  untouched**.

This is upsert, not mirror. We deliberately reject a mirror (replace-all) model:
"source of truth" here means the file is authoritative _for the dates it covers_,
not that it owns the whole asset — so a hand-entered operation the broker doesn't
know about is never silently deleted.

The match key is the **date alone**. We assume at most one operation per date per
asset (true for MyInvestor's monthly DCA). A date that carries more than one
operation — in the file or on the asset — is surfaced as an anomaly in the
preview and not guessed at, rather than overwriting the wrong row. Quantity was
considered as part of the key and rejected: the existing operation may have been
hand-typed as an approximation, so a near-but-not-equal quantity must still count
as the same operation and be overwritten, not duplicated.

## Field mapping (MyInvestor)

The export gives `Fecha · ISIN · Importe estimado · Nº de participaciones ·
Estado`, semicolon-delimited, `dd/mm/yyyy` dates, `.`-decimal amounts and
`,`-decimal units.

- Only `Finalizada` rows load; `En curso` and `Rechazada` are skipped (not
  errors).
- `pricePerUnit = Importe ÷ units` (the export has no price column; for a
  no-fee fund subscription the amount is units × NAV, so this reconstructs the
  NAV and the cost basis equals the amount). `feesMinor = 0`, `currency = EUR`.
- **Buy vs sell** has no column. Working assumption: a negative `Importe` or
  negative units ⇒ `sell`, stored as absolute values with `kind: "sell"`;
  otherwise `buy`. This is unverified — see Consequences.
- **ISIN guard:** the file's ISIN must match the selected asset's ISIN (block on
  mismatch; backfill the asset's ISIN when empty; reject a file with mixed
  ISINs). This turns a wrong-file slip into an obvious error instead of silent
  corruption.

## All-or-nothing, preview first

The flow is: parse + validate → show a **preview** ("N nuevas · M sobrescritas ·
K omitidas", with detected sells called out) → on confirm, apply. A malformed
`Finalizada` row aborts the whole load and writes nothing, matching the
full-workspace **Import** contract (ADR 0010). The preview is the human check that
the ISIN guard and sell-detection assumption produced the expected shape before
anything is written.

## One batched ripple per load

Each operation is a backdated dated fact that, per ADR 0012, generates a snapshot
at its date and ripples existing snapshots forward. A statement can create a
dozen-plus operations stretching back months; rippling per operation would
re-derive history N times — the O(N×snapshots) cliff behind the #158
`ECONNRESET`. So a statement applies in **one transaction** and ripples **once**:
like the amortization-plan exception in ADR 0012, it generates a snapshot at
_each_ affected operation date, then runs a single forward recalculation from the
earliest affected date. This needs a small batched ripple entry point alongside
the per-operation `rippleHistoricalSnapshotsForOperation`.

## Considered options

- **Mirror (replace-all) instead of merge** — rejected: it would delete any
  operation absent from the file, silently wiping hand-entered ones, and is only
  safe if every export is always complete. Merge keeps the file authoritative
  without owning the whole asset.
- **MyInvestor as a connected source** (ADR 0016 shape) — rejected for this
  feature: the user's model is per-ISIN, operations-centric, and file-based, not a
  live API mirror that owns a projected holding. A statement feeds operations into
  an asset whose value still comes from a price provider.
- **Date + quantity as a joint match key** — rejected: an approximate hand-typed
  operation would fail to match its precise file counterpart and duplicate. Date
  is the key; quantity is not.
- **`.xlsx` support** — deferred: MyInvestor exports `.csv`, so no spreadsheet
  dependency is pulled in until a real `.xlsx` appears.

## Consequences

- The buy/sell sign convention is **assumed, not observed** — we have no sample of
  a MyInvestor sell. If sells turn out to be unsigned (positive amount and units,
  direction encoded outside these columns), a sell silently imports as a buy and
  the preview will not catch it. A real reembolso export must be checked before
  the sell rule is trusted in anger.
- Statement load is idempotent: re-uploading the same file overwrites matching
  dates with identical values and triggers a ripple that rebuilds nothing.
- Editing an imported operation by hand and then re-uploading restores the file's
  value for that date — the file wins on every overlap, by design.
