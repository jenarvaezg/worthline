Status: ready-for-agent
Title: No-key price providers and refresh

## Parent

.scratch/worthline/PRD.md

## What to build

Add no-key price providers and refresh controls. The app should be able to refresh FX rates, crypto prices, and best-effort listed security prices without requiring API keys. Unsupported or failed prices must fall back to manual/last-known values with visible status.

The completed slice should allow on-demand refresh while keeping snapshots separate from live recalculation.

## Acceptance criteria

- [ ] ECB FX rates can refresh supported currency conversion data without an API key.
- [ ] CoinGecko keyless crypto prices can refresh configured crypto assets where supported.
- [ ] Stooq best-effort listed security prices can refresh configured provider symbols where supported.
- [ ] The dashboard includes a global refresh action and a per-asset refresh path where practical.
- [ ] Refreshing prices updates current valuations but does not automatically create a snapshot.
- [ ] Provider errors are shown and the last valid/manual price remains usable.
- [ ] The provider architecture can later accept optional user-provided API credentials without changing domain calculations.
- [ ] Tests mock provider success, provider failure, stale cache refresh, unsupported ticker fallback, and no-snapshot-on-refresh behavior.

## Blocked by

- .scratch/worthline/issues/08-price-freshness-and-manual-fallback.md
