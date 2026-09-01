# Numista coins: valuation and synced history

> **Amended 2026-07-31 (#1354): the metal spot moved from Stooq to Yahoo
> futures.** Stooq's `XAUUSD`/`XAGUSD` feed died to anti-bot protection around
> 2026-07-10 and `fetchMetalSpotEur` returned null for every metal, which silently
> deleted the melt rung: measured on two real collections, **0 of 239 coins** had
> a metal value, leaving 77 coins with a known weight and fineness reading 0 €.
> The spot now comes from Yahoo's front-month futures — `GC=F` (gold), `SI=F`
> (silver), `PL=F`, `PA=F`; Yahoo's spot pairs `XAUUSD=X`/`XAGUSD=X` return an
> empty result and cannot be used. A front-month future is not pure spot: the
> basis is under 1%, an accepted and documented approximation for a melt-value
> FLOOR. Still no new credentialed dependency: the provider is already in the pool
> and owns the USD→EUR conversion via ECB internally (so the pipeline is now one
> leg, not two).

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
  price, sourced from the **Yahoo** provider's metal futures (USD/oz) converted to
  EUR via the existing **ECB** FX provider (Stooq until #1354). No new price
  provider, no new API key.
- **Fallback** — when neither is available (a base-metal coin Numista does not
  estimate), the coin falls back to its **purchase price**; absent even that, it
  is 0 and raises the existing "value at 0" **warning**.

### A zero is named, never papered over (#1356)

A missing input is **never assumed**: an unknown fineness is not defaulted to
999, an unknown weight is not inferred from the denomination. A fabricated melt
value would move the net-worth figure with no way for the user to tell, which is
worse than a coin visibly reading 0 €.

What the zero owes the user is an **address**. `coinValueGap` (domain) names the
ONE input that, supplied, would rescue the coin most cheaply — the melt rung first
(`fineness` → `weight` → `spot`, because a weight and a ley rescue a coin whatever
Numista estimates), then the numismatic rung (`grade` → `issue` → `estimate`). One
coin reports one gap, so a collection's gap counts partition its unvalued coins
and the panel can say "62 sin grado en Numista, 15 sin la ley del metal".

That diagnosis is also why `UNVALUED_POSITION` is raised **once per connected
source**, not once per position: measured on a real 178-coin collection, 77
identical lines pushed everything actionable out of the panel. The affected object
was already the source, so the count folds into the same natural key, and the
per-coin detail stays where the coins are (the collection view, the agent view's
positions endpoint).

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
  estimates use a long TTL, and metal spot uses the daily Yahoo/ECB TTL. The two
  clocks are independent on purpose, which is what lets a spot outage's recovery
  restore metal values on the next daily pass without waiting for the long
  numismatic TTL (#1354).

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
  credentialed dependency and another rate limit, when the existing price pool +
  ECB already cover the common metals. Still rejected after #1354 killed Stooq:
  the replacement was another symbol on a provider already in the pool.
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
- **The numismatic fetched-at stamp advances only when Numista answered** (#1740)
  — in the on-demand position sync exactly as in the daily pass, from one shared
  rule in `numista-valuation`. A 5xx or a timed-out request leaves both the stored
  estimate and its stamp untouched, so the next pass retries instead of waiting out
  `NUMISMATIC_TTL_DAYS`. Stamping a silence would record freshness the collection
  never had: a months-old figure reading as valued today, with nothing to flag it.
  A coin whose line changed (issue, grade or quantity) carries nothing forward — it
  has no estimate of its own yet, and the old one would look fresh while being wrong.
- **A pass that fails halfway keeps the coins it already paid for** (#1739). The
  estimate is the capped call, so every coin a pass got through is money already
  spent; coin 60 failing cannot invalidate coins 1–59. Two mechanisms, because a
  pass dies in two ways:
  - **With an exception** — the failure path persists what the pass resolved BEFORE
    it marks the source stale, and only then leaves the prior fetched-at so the
    retry comes back. Writing zero updates there — the original behaviour — was
    self-perpetuating: the source was (rightly) left stale, which is the very
    condition that triggers the next pass, so the retry re-bought the whole
    collection and died at the same coin.
  - **Without one** — a collection is ~80 SEQUENTIAL Numista calls, so the request
    budget can run out and the process simply be gone, with nothing to catch. The
    pass therefore banks a tranche every `REVALUE_CHECKPOINT_COINS` coins. This is
    what makes the fix bite in production, where every injected read is total (a
    Numista failure resolves to `null`, it does not throw) and the exception path is
    nearly unreachable.

    A tranche persists with a **null freshness**: the values land and the holding is
    re-rolled, but the price-cache row is not stamped at all. The gate reads that
    row's `fetchedAt` and ignores `freshnessState` (`selectStalePrices`), so any
    stamp mid-pass would make an unfinished collection read as valued today — worst
    on a never-valued source, the pass with every coin still to buy — and it would
    also erase the previous failure's reason from the banner. Untouched, the source
    stays due until the pass actually ends.

  Measured on Jose's 78 priced coins: **440 `getPrices` calls on 2026-08-11 alone**,
  ~5.6 passes over the same collection in one day, with not one stamp surviving.
- The spot provider's coverage of platinum/palladium must be verified whenever it
  changes (`PL=F`/`PA=F` verified on Yahoo 2026-07-30); base-metal circulation
  coins lean on the numismatic estimate or the purchase-price fallback.
- The `client_credentials` end-to-end path and Numista's exact credential field set
  must be confirmed during implementation (see ADR 0016).
