# A mirrored holding is routed by its source, not by its instrument column

## Context

ADR 0014 made the **instrument** the first-class answer to "what is this holding?", and
ADR 0101 made every valuation method derive from it. That put a lot of weight on one
column — and the column has a backfill in its past.

Schema v14 (#149) derived `assets.instrument` from the legacy `AssetType`:

```sql
-- packages/db/src/migrate.ts
UPDATE assets SET instrument = CASE
  WHEN type = 'real_estate' OR is_primary_residence = 1 THEN 'property'
  WHEN type = 'cash' THEN 'current_account'
  WHEN type = 'investment' THEN COALESCE(…, 'fund')
  ELSE 'other' END;
```

A connected source materializes its holding with `type = 'manual'` (ADR 0016/0021), and the
backfill never looked at `connected_source_id`. So every collection connected **before v14**
fell into `ELSE 'other'`. Production had exactly one such row, found while sweeping #1680: a
live Numista collection, syncing, labelled `other`.

**Its money was right, and that is why nobody saw it.** The sync re-rolls the holding's value
from its positions matching the row by `(connected_source_id, liquidity_tier)` — never by
instrument — and the historical reconstruction routes coin collections through
`connected_sources → positions` before the valuation dispatch. Two paths, neither of which
reads the column.

Everything else read it, and answered as if the holding were a hand-kept «otro»:

- The **ficha** rendered the `stored` family: no coin lens, and an **instrument picker**
  offering to relabel it — because `instrumentShape` read the stored instrument, so a
  mislabelled row put itself in a correctable shape. `coin_collection` was not among the
  offers, so every move on the menu was wrong, and the one holding whose identity is not the
  user's to correct (ADR 0016/0021) was the one the app offered to correct.
- The hero's **change attribution** put the metal's movement in *ahorro neto* instead of
  *mercado* (`stored` contributes zero to the market leg).
- The **exposure catalog** left the whole amount unclassified (`unknown` class, `unknown`
  geography) instead of `commodity`.
- **`STALE_MANUAL_VALUE`** fired, `fixable: true`, pointing at a puesta al día that excludes
  connected holdings — an aviso that cannot be followed, the #1510-#1512 shape again.
- The **balance-reconciliation guard**, freshly fixed by #1680, admitted it: the derivation
  says `stored` for `other`. Only `valuation-guard.ts`, one call later inside the same
  transaction, refused the write.

## Decision

**Where a connected source owns a holding, the source is the fact and the instrument column
is a copy that must agree with it.**

1. **The ficha routes by adapter.** `holdingFamily` takes the owning source's
   `connectedSourceAdapter` and branches on it before any instrument branch. The instrument
   branches stay as the answer for a holding no source owns. The router's own read is now
   gated on the asset's `connectedSourceId` — a column it already has in hand — instead of on
   `instrument === "crypto"`, so a hand-kept holding still pays for no read and a mislabelled
   one is no longer invisible to the question.

2. **A holding's correctable shape is read off the ROW.** `shapeOfHolding` returns `connected`
   whenever `connectedSourceId` is set, whatever the instrument says, and the ficha's picker
   and its server action both ask it (`assignableInstrumentsForHolding`). A mislabelled row
   can no longer self-authorize into `manual`. This narrows ADR 0098: the correction is
   confined "within the holding's persistence shape", and the shape is the row's, not its
   column's.

3. **The sync re-asserts the instrument.** `rerollSourceHoldings` already rewrites the row on
   every sync, matched by source and rung; it now writes `instrumentForAdapter(adapter)`
   alongside the value. The mislabelled rows heal themselves at their next sync, and no future
   writer can leave one adrift for long. A **trashed** rung asset is untouched: a disconnect
   deliberately freezes it to `frozenInstrumentForAdapter`, and re-asserting the live one
   would undo that.

4. **Two guards stop leaning on the column.** `STALE_MANUAL_VALUE` fires only where the puesta
   al día would actually list the holding (`isValueUpdateEligible`), so it can never offer a
   fix that excludes its own subject. And `assertStoredDestination` refuses a holding with a
   `connectedSourceId` before it consults any derivation — `valuation-guard.ts` behind it
   would still refuse the write, but a guard that only holds because the next one does is not
   a guard.

5. **The existing rows are swept, not rippled.** `scripts/align-connected-instrument.ts`
   aligns every live connected holding's instrument with its adapter's. No figure on these
   rows derives from the column (see above), so there is no curve to re-ripple.

## Consequences

- A connected holding's ficha, exposure class, change attribution and data-quality signals no
  longer depend on a migration having guessed right in 2025.
- The instrument column stays authoritative for every holding a source does **not** own, which
  is all of ADR 0014 and ADR 0101 untouched.
- The generalized `readConnectedSourceOfAsset` replaces the crypto-only `readBinanceSource`, so
  a third adapter routes by construction instead of needing a new boolean.

## Alternatives considered

- **Derive the instrument at read time, like #1680 did with the method (rejected).**
  `instrumentOfAsset` is called everywhere, from pure domain code with no store in reach;
  making it resolve `connectedSourceId → adapter` would put a join behind the most-called
  classification seam in the codebase. The write path already touches these rows on every
  sync, so that is where the invariant is cheapest to hold.
- **Fix the row and stop (rejected).** That is the tirita #1680 opened with. Without rule 3
  the next pre-v14 workspace restored from a document reproduces it, and without rules 2 and 4
  the app keeps trusting the column in the places where being wrong is invisible.
- **A migration instead of a script (rejected).** The heal is idempotent and belongs to the
  sync, which runs against every live source anyway; a migration step would duplicate the
  adapter→instrument mapping in SQL, which is the second-derivation mistake ADR 0101 is about.
- **Drop `frozenInstrumentForAdapter` and keep the live instrument after a disconnect (out of
  scope).** A frozen holding is genuinely hand-valued from then on; the freeze is the correct
  behaviour, and rule 3 is scoped to live rows precisely to preserve it.
