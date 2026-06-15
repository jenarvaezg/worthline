# Connected sources are read-only external mirrors

worthline is manual-first: for every holding, the app is the source of truth and
the user types the data. Tracking coins breaks that assumption — the user curates
the collection _on Numista_ (catalogue, **grade**, buy/sells), so Numista owns the
truth and worthline can only reflect it. Rather than build a Numista snowflake, we
introduce a generic **connected source**: an external account worthline links to,
authenticates against, and **mirrors read-only**, refreshed by **syncing** on
demand. Numista (a numismatic collection) is the first; a brokerage or an exchange
would be the same shape pointed elsewhere.

A connected source has an adapter (authenticate + list **positions**) and a
**projection** into the portfolio: **one holding per source per liquidity-ladder
rung**. Positions are sub-detail beneath that holding — exactly the way
**operations** sit beneath an **investment** (ADR 0014) — and carry grouping
metadata (a coin's metal, a token's symbol) for a presentation lens on the
detail page. The projected holding's value is **derived** (computed from its
positions, never hand-set), so it is excluded from the manual **value update
pass** and re-valued through the existing **price provider** machinery. This
keeps the five-method valuation axis intact: no sixth method is introduced.

Ownership has no analogue on the source, so it stays worthline's concern: a
connected-source holding carries a normal, editable **ownership split**,
defaulting to 100% the connecting **scope** member. It is the one mutable field
on an otherwise read-only holding. Disconnecting prompts the user to choose
between removing the live holding (frozen **snapshots** keep the history, as a
**hard delete** never touches history) and freezing it into a plain **stored**
holding maintained by hand.

## The MVP "no cloud sync" constraint

CONTEXT lists _"No auth … or cloud sync … in the MVP."_ A connected source is an
**outbound, read-only** mirror — the same kind of external read that **price
providers** already perform (Yahoo, CoinGecko, ECB) — not the prohibited thing,
which is inbound app-login or syncing worthline's own data up to a cloud. We
read the constraint as forbidding the latter, and connected sources as a
sanctioned extension of the existing price-fetch pattern. worthline still has no
account, no login, and no server holding user data.

## Authentication

Reading a user's Numista collection requires OAuth2 (the API key alone returns
403 on `collected_items`). Numista's documented example uses the interactive
authorization-code flow, but the **`client_credentials`** grant reads _your own_
collection non-interactively. Per Numista's API docs that grant authenticates
"to your own account" with **only** `grant_type=client_credentials` +
`scope=view_collection` in the body, plus the API key in the `Numista-API-Key`
header: **the API key _is_ the credential** — there is no separate OAuth client
to register (the authorization-code flow even defines `client_secret` _as_ the
API key). So the user generates their Numista API key and stores **just that**
in local config (`.env`, gitignored); worthline mints and caches the ~2-hour
access token on demand and re-mints on expiry. This is the first time worthline
holds a delegated credential.

## Considered options

- **A Numista-specific feature, no abstraction** — rejected: the next integration
  (an exchange, a broker, a bank) would start from scratch, and the glossary would
  gain a one-off term instead of a reusable one.
- **Each position is its own holding; the collection is a grouping lens** — the
  most literal reading of ADR 0014. Rejected for the rollup case: N read-only
  holdings each need an ownership split, the portfolio list needs new
  collapse-to-one-line UI, and trash/delete/warnings multiply. The
  positions-as-sub-detail model reuses the operations precedent instead.
- **A parallel "positions" value layer beside holdings** — rejected: it splits the
  unified holding model in two, doubling every figure/snapshot/export code path.
- **Shared, app-shipped Numista credentials (zero setup)** — rejected: a local-first
  app can't ship its API key (the credential) safely, and a shared key would share
  the 2,000-request/month cap across all users. A cloud proxy to hide the key would
  itself violate local-first.
- **The documented authorization-code flow** — viable fallback, but it forces a
  browser round-trip and refresh-token bookkeeping; `client_credentials` is
  simpler and sufficient for a single-user local app.

## Consequences

- New persistence: a `connected_sources` row (adapter, local credentials, cached
  token, last-sync, projection policy) and a `positions` sub-entity beneath the
  projected holding. Both are local data, outside git.
- A projected holding is read-only except for its ownership split; UI and the
  trash/warning surfaces must respect that.
- **Export/import** (ADR 0010, 0015) must carry connected-source holdings and their
  positions like any other holding, but credentials must never be exported.
- Snapshots freeze a connected-source holding's value like any other; see ADR 0017
  for how a coin's purchase date enters history.
- Per-rung projection assumes a source can span rungs; Numista cannot (coins are all
  illiquid), but the framework is built for one that can.
