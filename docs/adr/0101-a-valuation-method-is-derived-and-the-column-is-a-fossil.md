# A valuation method is derived, and the stored column is a fossil

## Context

ADR 0014 decomposed "kind" into attributes and made the **valuation method** one of them:
how a holding's value evolves (stored / derived / appreciating / amortized / anchored). It
also said where the method comes from — an asset's **instrument** defaults it
(`defaultsFor(instrumentOfAsset(asset)).valuationMethod`), a liability's **debt model** does
(`defaultValuationMethodForDebtModel`).

Schema v13 (#148) backfilled `assets.valuation_method` and `liabilities.valuation_method`
from the legacy `AssetType` / `DebtModel` as forward-prep, and the app then moved onto the
derivation and stopped writing the columns. What it did not do was stop **reading** them.
Three seams kept deciding with the column, falling back — when it was NULL — to
`defaultValuationMethodForAssetType(type)`, the pre-ADR-0014 mapping the decomposition
existed to replace:

| seam | what it did with the value |
| --- | --- |
| `contribution-plan-store.assertStoredDestination` | **guard**: refuse anything not `stored` |
| `workspace-document-store` export | wrote it into the document |
| `workspace-document-store` import | wrote the document's back into the column |

Auditing a real workspace after #1512 surfaced the row that makes the cost concrete: a
«Colección Numista» — a connected coin collection, whose value is derived from its positions
and can never be hand-set (ADR 0016) — with `valuation_method = 'stored'`. It **passed the
guard** that exists to admit only declared-value destinations. Nothing was corrupted, because
the connected-valuation guard sits behind it, but the outer door was admitting exactly what
it exists to refuse.

Two more consequences followed from the same reading. The document **round-trip perpetuated**
the error: the export copied the rotten column into the file and the import copied it back,
so exporting and re-importing fixed the incoherence instead of curing it. And the import
**re-manufactured** it: it derived `instrument` with the ADR 0014 rule and `valuationMethod`
with the old one, two lines apart, so a coin collection came out `manual → stored` no matter
what the file said. Blanking the column to NULL would not have helped for the same reason:
the fallback rebuilt it just as wrongly.

## Decision

**A holding's valuation method is derived from the holding, and no code decides with the
stored column.**

1. **One seam per side, and only one.** An asset's method comes from
   `valuationMethodOfAsset`, a liability's from `valuationMethodOfLiability`. Both were
   already the live path; they are now the ONLY path. `valuationMethodOfAsset` takes a
   `ClassifiableAsset` — the instrument plus the legacy pair it falls back to — so a seam
   holding a raw DB row asks the derivation instead of growing its own.

   `defaultValuationMethodForAssetType` is deleted: it was the superseded derivation with no
   remaining production caller, and an exported second way to answer one question is how a
   stale mapping stays in circulation. `defaultValuationMethodForDebtModel` survives as the
   implementation of `valuationMethodOfLiability` but leaves the package barrel, so each side
   presents one public door.

2. **The document declares the derived method, on both sides of the wire.** The export
   derives it rather than copying the column; the import derives it rather than trusting the
   file. A hand-rolled v1 document therefore cannot plant a method that contradicts the
   instrument it also declares, and a round-trip **cures** an incoherent workspace rather than
   fixing it in place. This narrows ADR 0015's "the payload carries the entire model": the
   payload still carries `valuationMethod`, but it is now a **readable derivation**, not a
   restorable fact — the same status ADR 0006 gives an investment's value, which the document
   also omits rather than restores.

3. **The columns stay, dead and documented.** They are not read, and they are not dropped
   either: the document format serializes `valuationMethod`, so removing them is a migration
   plus a format version, which is a separate decision. The schema says so at the column, so
   the next reader learns it is a fossil before wiring anything to it.

4. **The stale rows are swept, not rippled.** `scripts/align-valuation-method.ts` aligns both
   columns with the derivation across every workspace (dry-run by default). It is a query, not
   a recalculation: this value enters no valuation, so there is no curve to re-ripple and no
   snapshot to rebuild. A workspace it cannot open exits non-zero, so an incomplete sweep is
   never read as a clean audit.

## Consequences

- The balance-reconciliation guard now refuses a connected coin collection, which it should
  always have refused. It still admits every declared-value destination, including a row whose
  column was never backfilled — the derivation, not the column's NULL-ness, decides.
- Any future surface that needs a holding's method has one place to ask, and the type it takes
  (`ClassifiableAsset`) tells it exactly which columns it must have in hand.
- The invariant is now testable in one grep: no seam under `packages/db/src` decides with
  `valuation_method`.

## Alternatives considered

- **Set the column to NULL everywhere (rejected).** The NULL fallback was itself the wrong
  derivation, so blanking the column changed nothing about the guard's answer; it only made the
  wrongness less visible.
- **Keep the column authoritative and fix the bad row (rejected).** That is the tirita that
  opened this ticket. Two writers of one fact — a derivation the app runs and a column nobody
  maintains — drift again the moment another row is written by an older path or a hand-rolled
  document.
- **Drop the columns in this change (deferred).** It needs a migration and a document-format
  version, and neither is required to close the hole. Rule 3 leaves them inert and labelled so
  the removal is a mechanical follow-up.
- **Have the document keep transporting a declared method (rejected).** It would mean honouring
  a file that says `stored` about an instrument that is `derived` — accepting, at the import
  boundary, precisely the incoherence this decision removes. ADR 0010's faithful-restore promise
  covers declarations; a derivation is not one.
