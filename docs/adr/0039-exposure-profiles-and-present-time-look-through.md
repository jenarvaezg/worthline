# Investments carry a shared, ISIN-keyed exposure profile; look-through is a present-time lens, never frozen

## Context

worthline records what a holding **is** via its coarse **instrument** (`fund`, `etf`,
`stock`, `pension_plan`, `crypto`…) and already aggregates a scope's assets by instrument
and by liquidity tier — present-time, in the agent view's exposure block (the
`AgentViewAllocationSlice` shape: `{ key, value, weight }`). But it knows nothing of what a
fund actually holds underneath: no tracked index, no TER, no geography, no underlying
currency, no asset class. An agent (or the user) deciding "how much US equity do I really
have" must hand-compute it from outside knowledge, mixing "the S&P is 100% US, the World is
~70% developed" by hand — exactly the invention we want to stop.

Two facts shape the design. First, **ISIN already exists** as inert reference metadata on
`investmentAssets` — stored, but it fetches no price and nothing else hangs off it. Second,
there is **no FX layer**: every value is assumed already in the base currency (EUR), so a
fund's _underlying_ currency exposure (a EUR-denominated S&P fund is USD-exposed) exists
nowhere. No geography / sector / TER / asset-class field exists anywhere in the model.

The data has no free feed: OpenFIGI maps ISIN→ticker only; geography and constituent
composition are paywalled (Morningstar-class). So composition is hand-entered, and the
ambition of resolving down to individual securities ("Nvidia summed across all my funds")
cannot be sustained by hand.

## Decision

Introduce an **exposure profile**: a shared, canonical record of what an investment holds
underneath, and a present-time **look-through** that aggregates it across the portfolio.

- An **exposure profile** is keyed by **ISIN**, with a fallback key for instruments that
  have none (e.g. a crypto coin id). Two holdings of the same security share one profile —
  the canonical identity the instrument category never provided.
- It carries **breakdown vectors** per dimension — geography (a fixed MSCI-style region
  enum: `us`, `europe_developed`, `japan`, `pacific_developed`, `emerging`, `other`),
  underlying currency (ISO 4217), asset class (a fixed enum: equity / bond / cash /
  commodity / property / mixed) — plus scalars: TER and a tracked-index label. The model is
  **dimension-agnostic**: a breakdown is a set of `bucket→weight` entries, so a finer
  breakdown (sector, or constituent securities) is the **same shape at higher resolution**,
  not a new model.
- A breakdown **need not sum to 100%**: the remainder is an implicit `other` (only what is
  known is declared). A breakdown **over 100% is rejected** as a data error. Normalising an
  under-100% vector to sum to 100 is forbidden — it would assert regions that are not there.
- An exposure profile is **reference metadata, not a figure the math reads** — like the
  instrument, a descriptive label. It never touches **net worth**, **snapshots**, **ripple
  recalculation**, or any calculation. This is what keeps it clear of ADR 0008.
- **Look-through** sums each holding weighted by its profile, per dimension, **present-time
  only**, mirroring the existing exposure breakdowns. It is **never frozen into a snapshot**,
  so it does not touch ADR 0008 and there is no historical look-through in this decision.
- **Coverage is always reported**: classified value vs gross assets, so an unclassified
  remainder is surfaced, never hidden behind a figure that pretends to cover 100%. **Cash**
  and **property** get profiles **auto-derived** from their instrument and the base currency,
  so hand-entry falls only on market instruments; **coins are excluded** (ADR 0017, frozen).
- Because **asset class is itself a breakdown axis**, a consumer restricts to equity and then
  reads geography to get "US equity exposure" honestly.
- v1 is **hand-entered** by the user. Deepening to constituent level — the correlated-overlap
  insight a fund-level view structurally cannot show — is reached later by a **narrow
  exposure-profile write** that lets an agent populate profiles. That write is an
  **annotation surface, distinct from general write-back** because it mutates no figure; each
  agent-supplied breakdown is stamped as declared, with source and date.

## Considered options

- **Per-holding metadata instead of a shared canonical record (rejected).** Simpler, but
  re-entered for a duplicated holding and gives no single identity for "what this security
  is." The shared record dedups and matches the canonical-instrument intent, and ISIN is
  already present to key it.
- **A single geography tag per instrument instead of a vector (rejected).** Cheapest, but one
  tag cannot express a multi-region fund, so it cannot answer the question that motivated the
  feature. The vector's degenerate case (one entry) is just as cheap for a single-region fund.
- **Full constituent look-through as v1 (rejected for now).** The most powerful — it reveals
  correlated concentration a fund-level view hides — but constituent data has no sustainable
  hand-entry and no free feed. It stays reachable cheaply because it is the **same model at
  higher resolution**, populated later via the narrow agent write.
- **A paid composition feed (rejected).** Morningstar-class data would automate
  geography/constituents, but adds cost and a vendor dependency for a personal-scale tool.
  Manual entry plus optional agent-fill covers the real portfolio.
- **Freeze look-through into snapshots for historical exposure (rejected).** Would show past
  geography drift, but it requires freezing profile metadata into every snapshot and touches
  ADR 0008's reconciliation. Present-time look-through answers the decision at hand without
  that weight.

## Consequences

- The agent view stops inventing exposure: the existing exposure block gains geography /
  currency / asset-class breakdowns plus a coverage figure, and holding detail can expose a
  security's profile — the agent reads facts instead of hand-mixing them.
- Hand-entry burden falls on the handful of market instruments; cash and property auto-derive;
  coins stay out. Geography is stable year to year, so a hand-kept profile is sustainable in a
  way constituent weights would not be.
- **No snapshot, export/import, or reconciliation change is forced** — look-through is
  present-time and the profile is non-figure metadata. Export/import may later carry profiles
  as optional reference data, round-tripping older files unchanged.
- **Builds on** the unified holding model and instrument concept (ADR 0014) and reuses the
  inert **ISIN** (ADR 0011); **leaves untouched** ADR 0008 (snapshot reconciliation) and ADR
  0017 (frozen coins). The deferred agent-fill write, when it lands, **extends** the read-only
  agent view (ADR 0023) and the OAuth-protected MCP (ADR 0034) with a narrow, audited write
  scoped to exposure profiles — explicitly not general write-back.
- Sliced in PRD #539: **S0** (#540) model + storage + pure look-through aggregation + coverage;
  **S1** (#541) hand-entry UI + auto-profiles + validation; **S2** (#542) agent-view (MCP)
  exposure extension; **S3** (#543) dashboard look-through surface; **deferred epic** (#544) —
  narrow agent-fill annotation write (unlocks constituent depth).
