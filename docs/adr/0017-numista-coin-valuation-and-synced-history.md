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

- A coin position stores its catalogue id, grade, quantity, composition/weight,
  purchase date and purchase price, plus the two candidate values; the holding's
  detail page groups positions by metal.
- Stooq's coverage of platinum/palladium must be verified at build time; base-metal
  circulation coins lean on the numismatic estimate or the purchase-price fallback.
- The `client_credentials` end-to-end path and Numista's exact credential field set
  must be confirmed during implementation (see ADR 0016).
