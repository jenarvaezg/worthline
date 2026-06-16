# Binance: a live-valued, multi-rung connected source with API-bounded faithful history

The second **connected source** (ADR 0016) is a Binance account. Where Numista
(ADR 0017) mirrors a static collection valued by a frozen `max(metal,
numismatic)`, crypto is volatile and the user wants it **live** — the same "real
time más o menos" the manual `crypto` investment already gives. Binance is also
the first source that **spans liquidity rungs** and the first real test of the
generic connected-source shape ADR 0016 promised. The manual `crypto` path stays
untouched and the two coexist.

## Valuation: live, balance × price, via CoinGecko

A Binance **position** stores a **token balance** (quantity), not a frozen value.
The projected holding's value is **derived live** — `Σ balance × unit price`,
refreshed on worthline's existing stale-price pass (the decoupled revalue step),
exactly like the manual `crypto` investment. This is the sharpest divergence from
Numista, whose positions store frozen candidate values a re-sync must never move.

Prices come from **CoinGecko** (EUR-native), not Binance's own ticker:

- **Consistency** — a BTC held manually and a BTC on Binance then show the same
  unit price; Binance's USDT-quoted ticker would drift through USDT→EUR.
- **Precedent** — a connected source uses worthline's price machinery, not the
  source's own (Numista's metal value is Stooq+ECB, not a Numista price; ADR 0017).

The cost is a Binance-symbol (`BTC`) → CoinGecko-id (`bitcoin`) mapping; an
unmapped or unpriceable token falls to value 0 and raises the existing "value at
0" **warning**, still visible in the holding's detail (never silently dropped).

## History: faithful, monthly, bounded by the API

The user wanted to **see** the past curve, so — unlike Numista's frozen-at-current
value — Binance values the past at **historical** prices (crypto historical prices
exist; numismatic ones do not). The reconstruction is **monthly and API-bounded**:

- **Source of truth** — worthline walks Binance's API ledger **backward from the
  authoritative current balances** to derive each token's **month-end balance**.
  The CSV-export path (deep, multi-year, but a manual upload + parser, reusing
  ADR 0018's file-parse pattern) was deliberately rejected in favour of the
  automatic API window.
- **Horizon** — Binance exposes no clean full ledger (`myTrades` is per-symbol
  with no pair list; `accountSnapshot` is ~30 days; deposit/withdraw/earn/convert
  are windowed with limited retention), so faithful automatic history reaches
  **weeks-to-months, not years**. The curve **starts on a visible date**;
  worthline shows that honestly rather than implying nothing existed before.
- **Granularity** — "monthly" describes the **balance** resolution (a step
  function within the month), not the snapshot resolution. Because the daily
  historical price is cheap (one range call per token), worthline values **any**
  date: it adds `month_balance × that_day's price` to snapshots that already
  exist (additive — the Numista precedent) and **generates a monthly-close**
  where no snapshot exists (the amortization-plan precedent of a fact that
  generates a monthly series — ADR 0012/0019).
- **Earn** — capturing month-end balances absorbs Earn's daily reward drip into
  the balance itself, so Earn generates **no per-reward dated facts**. This was
  the user's explicit concern and is why monthly granularity is necessary.
- **Frozen** — each monthly value is **frozen once generated**; a later sync only
  **appends new completed months** and never rewrites the past, preserving the
  frozen-snapshot guarantee.

## Multi-rung projection: the first source to span rungs

Binance's wallets map to two rungs, so the source **projects one holding per
rung** (ADR 0016's framework, never exercised by all-illiquid Numista):

- **spot + funding + flexible Earn → market** (redeemable now);
- **locked Earn / locked staking → term-locked** (locked until a date);
- **futures and margin are excluded** — leveraged equity (notional ≠ equity, can
  go negative, liquidatable) does not model as a plain holding in a net-worth panel.

## Coexistence with manual crypto

Manual `crypto` investments are untouched and are the way to track holdings
**outside Binance** (cold wallet, another exchange, hardware). The two paths
**coexist with no duplicate detection**: both count, and worthline never dedupes
or warns. This honours manual-first — worthline reflects exactly what it is told,
and a double-entry is the user's call, not something the app silently reconciles.

## Authentication: read-only key + secret, HMAC, no token

Binance authenticates with an **API key + secret**, the secret signing each
request with **HMAC-SHA256** — so, unlike Numista's OAuth, there is **no token to
mint or cache** (`tokenJson` stays null). Credentials are entered in the settings
form and stored locally in `connected_sources.credentialsJson` (outside git,
never exported — ADR 0016). The key must be **read-only** ("Enable Reading"; no
trade, no withdrawal): the secret is more dangerous than Numista's read key
because it can sign actions.

## Consequences: the generic shape, finally realized

Binance forces the connected-source code — today Numista-shaped — to generalize:

- `SourceAdapter` becomes `"numista" | "binance"`.
- `SourcePosition` becomes polymorphic (a coin's metal/fineness/grade/numismatic
  vs a token's symbol/balance/wallet/lock) — a discriminated union, or a common
  core plus an adapter-typed payload.
- Valuation dispatches per adapter: `coinValue()` (frozen max) vs a crypto
  `positionValue()` (balance × live price); likewise the **revalue** step
  (recompute melt + refetch numismatic vs fetch live CoinGecko price) and the
  **history builder** (purchase-date accretion vs monthly API reconstruction).
- `connect()` stops hardcoding `coin_collection`/`illiquid`; the projection emits
  one holding per occupied rung.
- The price-cache source vocabulary gains `"binance"`, with its own TTL row
  (ADR 0007/0011).
- Export/import carry Binance holdings and positions like any other holding;
  credentials never leave (ADR 0016/0015).

## Considered options

- **CSV statement for deep history** (reuse ADR 0018's file-parse pattern) —
  rejected by the user in favour of the automatic, shorter API window; the CSV's
  only advantage is multi-year depth.
- **Numista-style frozen valuation** — rejected: a frozen value applied to a
  volatile asset produces a meaningless flat curve and contradicts "live".
- **Trade-mirror as derived investments** (Binance trades → operations) —
  rejected: not the connected-source shape, Binance's trade ledger is messy
  (per-symbol queries, dust, BNB fees, Earn, airdrops), and it multiplies
  first-class holdings (the very thing ADR 0016 rejected).
- **Binance's own price ticker** — rejected: USDT→EUR drift and divergence from
  the manual-crypto unit price; the source-owns-truth principle already yields to
  worthline's pricing for Numista.
- **Auto-dedupe or warn on manual/Binance overlap** — rejected: silent dedupe
  violates manual-first, and the user opted for no warning at all.
