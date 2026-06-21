# Connected-source holdings freeze a per-position breakdown into each snapshot, going forward

## Context

A connected source (the Numista coin collection, a Binance account) materializes a
single holding. ADR 0008 makes a historical snapshot a set of **frozen holding rows**
that reconcile to the headline figures: assets sum to gross, liabilities to debts, and
the liquid/housing axes are derived purely from each row's frozen flags. A connected
holding therefore appears in history as **one row** — its total value on that date —
and the per-coin / per-token detail that produced the total is discarded before the
snapshot is frozen.

That detail exists at capture time. The source projection values every position to
build the holding total: a coin's frozen `max(metal, numismatic)` (ADR 0017, never
re-priced in the past), a token's live `balance × price` (ADR 0021). But once summed,
the histórico can only show that "Colección Numista" or "Binance" moved — never which
coin or token moved it. The user watching the chart cannot explain a movement.

We want a **second drilldown level**: expand a connected holding on a snapshot and see
each position's contribution. The constraint is that worthline keeps **no historical
price series** — the only historical record is the snapshots themselves, and
`asset_price_cache` holds the latest price only. Reconstructing arbitrary past
per-position values would require a price-history subsystem (and is impossible for
numismatic estimates, which have no past). PRD #459 drives this.

## Decision

Freeze a **per-position breakdown** of each connected-source holding into the snapshot,
**from the moment the feature ships forward**, as child rows of the snapshot's holding
row.

- A new child relation (`snapshot_position_holdings`) stores one row per position per
  snapshot: the parent snapshot-holding identity, a stable `position_key` (the coin's
  `externalId` / a token's `symbol:wallet`, the ADR 0017 identity), a `label`, a
  `value_minor`, and the minimal display metadata the row renders (grouping tag, image
  url). **Values and labels only — never credentials, tokens or raw provider payloads.**
- The breakdown is written by the **normal snapshot generation path**, from the values
  the source projection already computes. No historical price series is introduced and
  ADR 0017 is unchanged — a coin is still frozen, never re-priced in the past; the daily
  snapshot simply records the live breakdown it already evaluates.
- **Reconciliation extends (ADR 0008):** for any holding that carries position rows,
  `Σ(position value_minor) == holding value_minor` exactly, under the same scope
  allocation and rounding as the holding. A holding with **no** position rows reconciles
  exactly as before. The import validator checks the sub-sum and rejects a
  non-reconciling snapshot, naming it.
- **Scope allocation stays at the holding level:** position rows inherit the parent
  holding's split; there is no per-position member ownership.
- **The drilldown's second level is derived in the domain** (a sibling of the existing
  holding-multiples builder); the histórico table renders the derived structure and adds
  no logic of its own.
- **Past snapshots are not reconstructed by the product.** Backward compatibility is by
  absence: a snapshot without position rows shows only the holding line, no expander.

## Considered options

- **Reconstruct the past generically (rejected).** Re-derive each position's value on
  every past date. Possible for Binance (its history curve is keyed per symbol) but
  impossible for numismatic coins (no past estimates) and unavailable for metal coins
  (no stored metal-spot history). It would require a whole price-history subsystem for
  partial, unfaithful results, contradicting ADR 0017's reason for freezing coins.
- **Store the breakdown as JSON on the existing holding row (rejected).** Avoids a table
  but makes the reconciliation sub-sum, the import validation, and any future per-position
  query opaque and unindexable; a child relation keeps the invariant first-class and
  matches how holding rows are already modeled.
- **Derive the breakdown live for the latest snapshot only (rejected).** Cheap, but the
  whole point is to explain _movements over time_; only frozen history can attribute a
  change between two dates.
- **One-off local backfill for the single real workspace (accepted, out of product).**
  The sole real workspace gets its past backfilled by a script kept out of the public
  repo (`.local/scripts/`): Binance per symbol from the history curve, coins frozen at
  their current value from their acquisition date forward. This is data work for one
  workspace, not a shipped capability.

## Consequences

- The histórico can attribute a connected holding's movement to specific coins/tokens,
  from launch forward. Binance's second level is price-driven (it varies day to day);
  Numista's is acquisition-driven (a frozen step function — a coin entering on its
  acquisition date is the only thing that moves the line), consistent with ADR 0017.
- A position that disappears (a coin sold on Numista, a token zeroed on Binance) stays
  in the snapshots it was part of — history remains faithful, mirroring how the
  holding-level ripples already preserve frozen rows.
- The reconciliation invariant grows a per-holding sub-sum check; the export/import
  contract gains an **optional** `positions` field, so older exports round-trip
  unchanged. Demo mode is unaffected — rows are value-only and respect the existing gate.
- Snapshot writes do more work and storage grows by roughly (positions × snapshots) for
  connected sources; acceptable for a personal-scale collection, and bounded because
  only connected holdings carry position rows.
- **Extends** ADR 0008 (snapshot reconciliation) and ADR 0028 (snapshot module split);
  **builds on** ADR 0017 (frozen coins) and ADR 0021 (live Binance, per-symbol history
  curve) without revising either. The work is sliced in PRD #459 (S1 ADR + schema +
  reconciliation, S2 capture, S3 export/import, S4 UI).
