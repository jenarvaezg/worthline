# Numista coins: valuation and synced history

The first **connected source** (ADR 0016) is a Numista numismatic collection. This
records how a coin is valued and how it enters worthline's history.

## Valuation: max(metal, numismatic)

A coin's value is the greater of its **metal value** and its **numismatic
value**, taken per coin and summed into the rolled-up holding. A bullion coin is
worth its melt value when that exceeds the collector estimate; a rare coin is
worth its collector estimate when that exceeds the metal. Concretely:

- **Numismatic value** — Numista's estimate for that coin at its **grade**
  (assigned on Numista, read by worthline), requested in EUR.
- **Metal value** — composition × weight (from Numista's coin detail) × spot
  price, sourced from the **Stooq** provider (e.g. XAU/XAG in USD) converted to
  EUR via the existing **ECB** FX provider. No new price provider, no new API key.
- **Fallback** — when neither is available (a base-metal coin Numista does not
  estimate), the coin falls back to its **purchase price**; absent even that, it
  is 0 and raises the existing "value at 0" **warning**.

## History: purchase date ripples, value frozen at ripple time

A coin's **purchase date** (from its Numista trade) is a **dated fact about the
past**, like a backdated **operation**: it triggers a **ripple recalculation**
(ADR 0012) of existing **snapshots** from that date forward, placing the coin on
the timeline when it was acquired. The value stamped in is the coin's value _at
the moment of the ripple_, then **frozen** — worthline never fetches a coin's
historical price, and a later price move never rewrites a past snapshot. Numista's
trade prices set _when_ a coin was held, not _how much_ it was worth then.

The ripple is **additive and once-per-trade** (S6, #167): each trade is keyed by
Numista's stable **collected-item id**, persisted on the position. A sync ripples
only trades seen for the **first time**, adding each coin's frozen value to the
existing snapshots dated on/after its purchase date — never re-deriving the
collection's value from current positions. That is what keeps history frozen (a
re-sync at a new price adds nothing) and lets a **sold** coin stay in the
snapshots it was rippled into while dropping from the live holding (it is never
subtracted). Only existing snapshots are touched; no new dates are generated. A
coin with **no acquisition date** recorded has no dated fact to ripple — it is
left out of history entirely, counting only in the live holding and in snapshots
captured from the sync forward.

Symmetrically, when a snapshot is **freshly generated at a past date** (by another
holding's backdated fact, or import gap-fill), the coin collection is valued by the
same **purchase-date accretion** — the sum of `coinValue` over coins acquired on or
before that date, frozen at generation time — not its full current value. So the
two paths agree on a shared date, and a snapshot dated before any coin was bought
never shows the collection. The diff (only first-seen trades ripple) keeps the two
paths from double-counting a coin into the same snapshot.

## Refresh: decoupled, within 2,000 requests/month

Numista's free tier allows 2,000 requests/month, so the two refreshes are
decoupled:

- **Positions** (`collected_items` — what you hold) sync on demand via an explicit
  "Sincronizar Numista" action, since trading happens on Numista and changes
  rarely.
- **Valuation** rides worthline's existing stale-price refresh and cache: coin
  details (composition/weight) are static and cached indefinitely, numismatic
  estimates use a long TTL, and metal spot uses the daily Stooq/ECB TTL.

This keeps a steady-state sync to roughly one list call plus occasional price
refreshes, comfortably under the cap.

## Considered options

- **Backfill full historical value** from Numista trade prices + historical metal
  spot — rejected: numismatic history is not available via the API, so past values
  would be approximate anyway, and it burns the request cap. Using current value
  placed by purchase date is simpler and the user explicitly accepted it.
- **Re-value past snapshots on every sync** ("today's prices backward") — rejected:
  it makes past net-worth figures wobble when coin prices move, breaking the
  frozen-snapshot guarantee the rest of worthline relies on.
- **A dedicated metals API** (goldapi.io, metals-api) — rejected: a second
  credentialed dependency and another rate limit, when Stooq + ECB already cover
  the common metals.
- **Manual spot entry** — rejected as the default: zero dependency but goes stale;
  kept only as a conceptual fallback.

## Consequences

- A coin position stores its catalogue id, **issue id**, grade, quantity, the
  **indefinite detail** (metal, parsed fineness and weight), purchase date and
  purchase price, the two candidate values, and **when the numismatic estimate was
  last fetched**. The issue id + detail let the decoupled refresh re-value a coin
  without re-listing the collection; the holding's detail page groups by metal.
- Valuation rides the dashboard's daily stale-price pass through one `numista`-source
  price-cache row on the coin-collection holding: metal value is recomputed every
  pass from the stored detail × the daily spot (free), while the numismatic estimate
  is refetched only past its long TTL (`NUMISMATIC_TTL_DAYS`, gated per position).
  A Numista outage keeps the last-known value and marks that row stale (it retries
  next pass), surfaced as a "valoración desactualizada" note on the detail page.
- Stooq's coverage of platinum/palladium must be verified at build time; base-metal
  circulation coins lean on the numismatic estimate or the purchase-price fallback.
- The `client_credentials` end-to-end path and Numista's exact credential field set
  must be confirmed during implementation (see ADR 0016).
