# Statements route by ISIN across the portfolio (partially supersedes ADR 0018)

## Context

ADR 0018 shaped the broker **statement** as strictly per-investment: one file, one
ISIN, uploaded against one chosen investment, with an ISIN guard that rejects a
file with mixed ISINs. That was the right v1 — it made a wrong-file slip an
obvious error — but it encodes an assumption the first real external user
immediately broke: brokers export the _whole account_. A MyInvestor "Órdenes"
export carries every order across every fund (a real sample: 153 orders across
26 ISINs, columns exactly as ADR 0018 documents, with **no fund-name column —
only ISIN**). Under the per-investment contract that file demands 26 manual
holding creations plus 26 filtered uploads; the user's verdict was "estamos
locos", and he is right: the file already contains everything needed to
reconstruct the full history.

What ADR 0018 got right and must survive: the merge-by-date semantics (file wins
on overlapping dates, absent dates never deleted), executed-rows-only,
preview-then-confirm, and the ripple discipline.

## Decision

A **statement** upload accepts any mix of ISINs and routes rows across the
portfolio:

1. **Group by ISIN.** The parsed rows split into per-ISIN groups. Each group
   resolves to one of three buckets in a single preview: _matched_ (an existing
   investment carries that ISIN — merge preview exactly as ADR 0018), _new_
   (no investment has it — a creation row), or _ignored_ (the user excludes the
   fund; not everything at a broker is worth tracking).
2. **Creation rows are prefilled by live symbol lookup keyed on the ISIN** (the
   add-holding wizard's search), because the export has no name column: the
   lookup turns `LU…` into a named, priced investment; when it resolves nothing,
   the name and provider symbol stay hand-editable and may be left empty.
3. **An investment created without a provider symbol is an honest, flagged
   state**: with no market price available, it values at **cost basis** — the
   ADR 0006 fallback (`deriveInvestmentValuation`: `marketValue ?? costBasis`;
   #183) — and raises an overrideable `MISSING_PROVIDER_SYMBOL` **warning**
   ("pending task" — set the symbol later; override it for hand-quoted funds).
   The warning applies to any investment without a symbol, not only imported ones.
4. **Confirm applies the included funds all-or-nothing.** ADR 0018's atomicity
   moves from "the file" to "the confirmed selection": one unresolvable ISIN is
   excluded and resolved later instead of blocking the other 25. Within the
   confirmation everything applies or nothing does.
5. **Entry points:** the portfolio level ("Importar extracto" on the portfolio
   and in the add-holding wizard) accepts any mix; the existing per-holding
   upload remains as the one-fund case of the same engine, its guard reduced to
   "every row's ISIN must match this holding" (backfilling an empty ISIN as
   today).
6. **Idempotent by construction:** re-uploading the same full export is a no-op
   — merge-by-date already guarantees it; creation rows match instead of
   duplicating on the second pass.

Merge semantics, executed-rows-only, sell handling, and ripple behavior are
unchanged from ADR 0018.

## Considered options

- **Portfolio-level ISIN routing with creation and per-fund selection (chosen).**
  One upload reconstructs an account's history; the real file drives the design.
- **Keep per-investment uploads, improve the rejection message.** Rejected: a
  better apology is still 52 manual steps for a 26-fund account.
- **Auto-create every unknown ISIN without a mapping step.** Rejected: nameless
  `LU…` holdings and untracked-on-purpose funds need the explicit
  match/create/ignore preview; silent creation buries mistakes.
- **All-or-nothing over the whole file.** Rejected: one unresolvable ISIN would
  hostage 25 resolvable funds; the selection is the honest atomic unit.
- **Value at last operation's price when no symbol.** Rejected (#684): diverges
  from the established ADR 0006 cost-basis fallback and would ripple through
  `atCostBasis` and snapshot semantics; cost basis is already honest and the UI
  does not over-promise market valuation.

## Consequences

- ADR 0018 is **partially superseded**: its single-ISIN entry contract (one
  file, one chosen investment, reject mixed ISINs) is replaced by this routing;
  its merge-by-date, preview-then-confirm, and ripple semantics remain accepted
  and are unchanged.
- `CONTEXT.md`'s **Statement** entry is re-worded: a statement lists one fund's
  or a whole account's movements; per-holding upload is the one-fund case.
- The `MISSING_PROVIDER_SYMBOL` warning lands on the existing warnings system
  (per-holding, overrideable) and flows into data-quality signals automatically
  when the shared engine unifies them.
- Real broker exports never enter the repository (public repo): test fixtures
  are synthetic files with the same shape.

## Amendment (#1348): a closed position has no pending task

Decision 3 above says a symbol-less investment "raises an overrideable
`MISSING_PROVIDER_SYMBOL` warning — a pending task". The pending task exists only
while the position is **open**. A fund sold in full is kept as history: it holds
no units, contributes nothing to today's figure, and no symbol would ever be
looked up for it — yet the warning regenerated on every daily read, buried the
actionable ones (open holdings with no price), and pushed the user to trash
legitimate history just to silence the noise.

So the warning is not emitted for a **closed** position: a `derived` holding that
has at least one recorded operation and whose net units are within
`CLOSED_POSITION_UNITS_EPSILON` (`0.0001`, dust from a rounded sell) of zero.
Two boundaries matter:

- **No operation yet ≠ closed.** A freshly created investment also holds 0 units,
  but its missing symbol is a genuine pending task, so it still warns. The rule
  keys off "has a ledger that nets to ~0", not off "holds nothing".
- **Reopening restores it.** A new buy puts units back and the warning returns —
  no state is stored, the filter is derived from the ledger on every read.

One definition, `isClosedPosition` in `warnings.ts`, and every consumer that
*shows* the warning feeds it the ledger it already has: the home hero and the
agent view's `get_data_quality` through the shared `#654` engine — where
`netUnitsByAssetId` is a **required** input precisely so neither can drift — plus
the /patrimonio board, the holding ficha, and `get_holding_detail`.

Two `collectWarnings` callers are deliberately left unfiltered, and neither shows
anything: `captureNetWorthSnapshot` writes `snapshot.warnings` into each frozen
capture, and `prepareDashboardState` fills `DashboardState.warnings`. Nothing
renders either field today. Threading the ledger into snapshot capture would
change what every historical reconstruction path persists (the ripple engine, the
gap-fill, the backfill) for a column no surface reads — so the closed-position
filter stops at the read surfaces. If either field ever gains a reader, it must
take the ledger at that point, not grow a second filter.

### Boundaries this filter deliberately does not police

- **Price freshness rides along.** `STALE_PRICE` / `FAILED_PRICE` are the same
  noise one step over: a sold-out position keeps its price-cache row, so its
  quote goes stale forever, and `FAILED_PRICE` is `high` — it turns the home
  hero red over a holding worth 0. A price nothing multiplies cannot compromise
  today's figure, so the data-quality engine skips those two for a closed
  position as well. This is why the agent view folds net units for **every**
  `derived` holding rather than only the symbol-less ones: a map narrowed to one
  code's candidates would under-populate the moment a second code reads it.
- **An over-sold ledger reads as closed.** `derivePosition` clamps a sell that
  exceeds the units held, so a mis-imported ledger nets to `0` and is silenced
  here. That is accepted, not ignored: over-selling raises its own position
  warning ("la venta de N unidades supera las M disponibles"), which is the
  honest signal for a data problem — a missing price symbol is not.

Related: the connected-source exemption (#685) is the same shape — a Binance or
Numista holding never carries a provider symbol because its source prices it.

## Amendment (#1331): an ISIN identifies the instrument, not the holding

Decision 1 above resolves a group to _matched_ when "an existing investment carries
that ISIN". That sentence hides an assumption this ADR never stated and the data model
never enforced: that **at most one** holding carries it. `investment_assets.isin` is
not unique, and the same instrument at two brokers is a legitimate, real portfolio —
the father's `IE00B1G3DH73` lives both in a CLOSED position of an old broker (97,65
uds bought and sold in full) and in the LIVE Cartera Indexada holding that keeps
receiving contributions.

Under a first-wins index, the second claimant is unreachable and the first wins by
creation order — which in that real case is the dead holding. So:

- **An ISIN (or the provider symbol that plays its role for pension plans and crypto,
  #695) identifies the instrument. It does not identify the holding.** A key claimed
  by more than one holding resolves the instrument and leaves the holding open.
- The assistant's S1 matcher (`holding-matcher.ts`, PRD #1103) indexes **every**
  claimant and, when a key has several, degrades the match from `strong` to a ranked
  proposal `ambiguous` flag included: the row still defaults to the best claimant, but
  it is never "safe to apply unattended", and the preview names how many holdings
  share the key so the user picks. The reconcile preview already knew how to reassign
  a candidate, so no new surface was needed.
- **Ranking, never resolution.** Two cheap disambiguators order the claimants: the
  holding whose name the document also matches, then a live position before a closed
  one. Closed is `isClosedPosition` — the one definition from the #1348 amendment
  above, net units over a real ledger; a value-is-zero guess would demote precisely
  the live-but-unpriced holding it exists to promote (a symbol-less investment values
  at cost basis, decision 3).
- **The document's own scope is not available.** "Which broker/portfolio is this row
  from" would be the strongest disambiguator, but the extraction contract carries no
  broker or scope per holding, so it is not part of the ranking today.

The statement router itself (`resolveStatementImportBuckets`) still first-wins a
duplicated ISIN, and there it can `delete`/`overwrite` operations of the holding it
picked: tracked as **#1366**, deferred because fixing it changes the importer's
preview surface (a bucket needs candidates, not one `assetId`).
