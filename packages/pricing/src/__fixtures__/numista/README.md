# Numista API fixtures (spike #161, ADR 0016/0017)

Committed, representative JSON payloads captured from the live Numista API v3.
The Numista client tests (`packages/pricing/src/numista.test.ts`) parse these
instead of touching the network, exactly as the Stooq/CoinGecko provider tests
mock `fetch`. **Do not include secrets** — strip any API key, token, or personal
identifiers before committing (replace with `***`).

## The auth recipe (confirmed by the spike)

- **Base URL**: `https://api.numista.com/v3`
- **Header on every request**: `Numista-API-Key: <API_KEY>`
- **Token**: `POST /oauth_token` with body `grant_type=client_credentials` +
  `scope=view_collection` — and the API key in the `Numista-API-Key` header.
  Per Numista's docs the client_credentials grant authenticates "to your own
  account" with **only** those two body params; the API key IS the credential
  (there is no separate client_id/client_secret to register — the
  authorization-code flow even defines `client_secret` AS the API key). Returns
  an `access_token` valid ~2h (`expires_in`); re-mint on expiry.
- **Authenticated reads** add `Authorization: Bearer <access_token>`.
- **Credential field worthline stores** (local `.env`, never exported):
  just `NUMISTA_API_KEY`.

## Expected fixture files

| File                   | Endpoint                                                     | Used for                                     |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| `oauth-token.json`     | `POST /oauth_token` (client_credentials)                     | token mint/expiry parsing                    |
| `collected-items.json` | `GET /users/{user_id}/collected_items` (whole collection)    | position sync (S2 #163)                      |
| `type-detail.json`     | `GET /types/{type_id}`                                       | composition/weight/metal (later slices)      |
| `type-prices.json`     | `GET /types/{type_id}/issues/{issue_id}/prices?currency=EUR` | per-grade numismatic estimate (later slices) |

For S2 (#163) only `oauth-token.json` and `collected-items.json` are exercised;
the other two are captured now so later slices already have their fixtures.
