Status: ready-for-agent
Title: Price freshness and manual fallback

## Parent

.scratch/worthline/PRD.md

## What to build

Add the local valuation cache and freshness model before external providers. A user should be able to set or update manual prices, see whether a price is fresh, stale, manual, or failed, and rely on the last known valid price when automatic pricing is unavailable.

This slice should define the pricing adapter boundary and cache semantics without requiring any external API calls.

## Acceptance criteria

- [ ] Prices store value, currency, source, price timestamp, fetch timestamp, freshness state, and stale reason.
- [ ] Manual prices can be entered and used for unit-based assets.
- [ ] Current net worth uses the latest valid price when no fresh price exists.
- [ ] The UI shows clear price status for supported assets.
- [ ] Freshness TTL rules exist by asset/provider type even if only manual provider is implemented.
- [ ] Provider failure state can be represented without breaking the dashboard.
- [ ] Tests cover fresh, stale, failed, missing, and manual price paths.

## Blocked by

- .scratch/worthline/issues/07-investment-operations-and-position-math.md
