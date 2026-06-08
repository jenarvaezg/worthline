Status: ready-for-agent
Title: worthline local-first net worth dashboard

# PRD: worthline

## Problem Statement

The user currently tracks household net worth in a custom spreadsheet. The spreadsheet contains monthly net worth history, per-person ownership, housing, mortgages, pension balances, cash accounts, crypto, metals, and manual formulas. It works, but it mixes historical snapshots, current state, valuation formulas, ownership rules, and manual updates in one fragile place.

The user wants a private, open-source, local-first app that calculates total net worth faster and more dynamically than the spreadsheet, without paying for a hosted service. The app should support personal and household views, separate liquid net worth from housing-inclusive net worth, update market prices when possible, preserve frozen snapshots over time, and provide a FIRE/Coast FIRE view based on manually entered monthly spending.

## Solution

Build `worthline`: a local-first personal net worth dashboard.

The MVP is a local web app backed by SQLite. It supports one or more members, assets and liabilities with ownership splits, liquidity tiers, manual valuations, simple investment operations, net worth calculations, snapshots, and a FIRE/Coast FIRE module. It is designed as a monorepo with domain logic separated from the web UI so a future mobile app can reuse the same core calculations.

The app starts with manual-first data entry. It can later add no-key price providers for FX, crypto, and best-effort listed securities, and eventually optional user-provided API keys. Historical spreadsheet migration is a personal one-off task, not a generic product feature.

## User Stories

1. As an individual user, I want to create a single-member workspace, so that I can track my personal net worth without household complexity.
2. As a household user, I want to add multiple members, so that assets and debts can be attributed to each person.
3. As a household user, I want to create household or group scopes, so that I can see combined net worth across selected members.
4. As a user, I want every asset and liability to have ownership percentages, so that net worth can be split by member.
5. As a user, I want to view net worth for total household, each member, or a custom scope, so that I can separate personal and shared finances.
6. As a user, I want to define EUR as the base currency, so that all totals are comparable.
7. As a user, I want assets to retain their original currency, so that foreign assets are still represented accurately.
8. As a user, I want to add cash accounts manually, so that current account balances contribute to net worth.
9. As a user, I want to add investment assets with units, purchase price, date, currency, and fees, so that positions can be calculated from operations.
10. As a user, I want to record buys and sells for listed investments, so that current holdings can be derived from my transaction history.
11. As a user, I want to record crypto holdings with units and currency, so that crypto can be included in liquid net worth.
12. As a user, I want to record pensions and funds manually, so that assets without easy price feeds can still be tracked.
13. As a user, I want to add physical metals with quantity, purchase value, and current manual valuation, so that physical holdings appear in net worth.
14. As a user, I want to add real estate as a gross asset, so that property value can be shown separately from related debt.
15. As a user, I want to add mortgages as liabilities, so that housing net worth can be calculated as property value minus debt.
16. As a user, I want to enter mortgage terms or a current balance manually, so that mortgage debt can be represented before a full amortization engine exists.
17. As a user, I want to classify each asset by liquidity tier, so that I can understand how accessible my wealth is.
18. As a user, I want a liquid net worth view, so that my net worth is not inflated by primary residence value.
19. As a user, I want a housing-inclusive net worth view, so that I can understand total wealth including property equity.
20. As a user, I want a gross-assets-and-debts view, so that leverage and liabilities are visible separately.
21. As a user, I want a liquidity pyramid, so that net worth is grouped by accessibility.
22. As a user, I want the liquidity pyramid to show net values by default, so that I can see the usable composition of my wealth.
23. As a user, I want to expand liquidity levels into gross value and associated debt, so that I can inspect what drives each tier.
24. As a user, I want to update manual valuations, so that property, metals, pensions, and unsupported assets stay current.
25. As a user, I want valuation freshness to be visible, so that I know whether a number is current, stale, manual, or failed.
26. As a user, I want to refresh prices on demand, so that I can recalculate current net worth when I choose.
27. As a user, I want the app to keep using the last known valid price if a provider fails, so that the dashboard remains usable offline or during API failures.
28. As a user, I want the app to cache prices with different freshness policies per asset type, so that price updates are useful without excessive external calls.
29. As a user, I want to use no-key price providers at first, so that setup does not require API accounts.
30. As a user, I want unsupported tickers to fall back to manual prices, so that missing market data does not block tracking.
31. As a user, I want optional future API credentials to be supported by design, so that better providers can be added later without redesigning valuation.
32. As a user, I want daily snapshots, so that I can preserve frozen historical net worth values.
33. As a user, I want monthly close snapshots, so that long-term progress can be compared without daily noise.
34. As a user, I want current live calculations to be separate from frozen snapshots, so that historical charts do not change unexpectedly.
35. As a user, I want to manually save a snapshot, so that I can capture a known point in time.
36. As a user, I want snapshots to record stale-price warnings, so that historical numbers remain auditable.
37. As a user, I want historical spreadsheet data to be imported manually or by a one-off script, so that the product does not need a generic spreadsheet import UI.
38. As a user, I want a dashboard showing total net worth, liquid net worth, housing-inclusive net worth, and gross/debt breakdowns, so that the key numbers are visible immediately.
39. As a user, I want the dashboard to show change since the previous snapshot and monthly close, so that progress is easy to interpret.
40. As a user, I want a compact table of positions and balances, so that the dashboard is useful for repeated review.
41. As a user, I want charts of net worth over time by scope, so that I can see long-term progress.
42. As a user, I want top contributors and detractors to net worth changes, so that I can understand what moved.
43. As a user, I want warnings to be visible but overrideable, so that imperfect migration or manual tracking does not block me.
44. As a user, I want overrides to be recorded automatically without requiring notes, so that the audit trail exists without slowing me down.
45. As a user, I want soft delete for important records, so that deleting an asset does not corrupt historical snapshots.
46. As a user, I want to undo a bad import batch in the future, so that migration mistakes are recoverable.
47. As a user, I want all money amounts stored precisely, so that calculations do not suffer from floating-point drift.
48. As a user, I want FIRE calculations based on manual monthly spending, so that I can quickly estimate financial independence progress.
49. As a user, I want FIRE assets to exclude primary residence by default, so that FIRE is based on investable wealth.
50. As a user, I want FIRE calculations per member, household, or custom scope, so that personal and household goals can be separated.
51. As a user, I want to configure safe withdrawal rate and expected real return, so that FIRE assumptions match my plan.
52. As a user, I want Coast FIRE age and percent funded, so that I know whether current investments can grow to the FIRE number without further contributions.
53. As a user, I want the MVP to work without login or local auth, so that local usage stays simple.
54. As a user, I want no telemetry, so that private financial data never leaves the machine unexpectedly.
55. As a future mobile user, I want the core logic to be shared with a mobile app, so that mobile does not require a rewrite.
56. As a future mobile user, I want mobile to support both daily checks and full management, so that the app can eventually replace the spreadsheet on all devices.
57. As an open-source user, I want the app to be personal-first but cleanly publishable, so that it can be run locally by others without private assumptions.
58. As a maintainer, I want the first implementation to be a vertical slice, so that the product can be validated before building every asset type and provider.

## Implementation Decisions

- Product name: `worthline`.
- Build a personal-first, open-source-ready local web app, not a SaaS product and not a budgeting clone.
- Use a local-first architecture with SQLite for the MVP.
- Use a monorepo architecture with separate web app, future mobile app, shared domain core, database layer, pricing layer, and shared contracts.
- Use Next.js for the initial local web dashboard.
- Use Expo/React Native later for the mobile app.
- Keep all domain calculations outside UI components so the mobile app can reuse them.
- Use TypeScript throughout the app and shared packages.
- Store money in integer minor units where currency supports it.
- Store unit quantities, prices, FX rates, and crypto quantities as decimal strings handled by decimal-safe calculation utilities.
- Use EUR as the base currency.
- Support multi-currency assets and liabilities.
- Model members as an arbitrary N-member set, not hardcoded people.
- Support individual mode and household mode through the same member/scope model.
- Model scopes as a member, household, or configured group of members.
- Model ownership as percentages attached to assets and liabilities.
- Keep ownership simple in the MVP. Historical ownership validity can exist internally or be added later, but the UI should assume current ownership.
- Model real estate as a gross asset and mortgage as a separate liability.
- Provide presentation modes for liquid net worth, housing-inclusive net worth, and gross assets with debts.
- Define liquid net worth as liquid assets minus non-mortgage debts.
- Exclude primary residence and mortgage from liquid net worth by default.
- Add liquidity tiers to assets so the liquidity pyramid can be calculated from normal asset data.
- Use a hybrid data model: transactions for assets with units, manual balance or valuation updates for assets that are not unit-based or not integrated.
- Implement simple financial operations rather than double-entry accounting in the MVP.
- Supported MVP operations include buy, sell, balance update, valuation update, loan payment, extra principal payment, deposit, withdrawal, and simple income.
- Calculate investment positions from operations.
- Calculate cost basis with weighted average cost in the MVP.
- Calculate simple unrealized P/L and optionally realized P/L.
- Do not implement tax-specific FIFO/LIFO or Spanish tax reporting in the MVP.
- Use warnings with override for most data consistency issues.
- Make only structurally impossible data blocking, such as invalid dates, missing currency, non-numeric amounts, or references to nonexistent owners.
- Do not require notes for overrides.
- Record overrides and warnings in an audit log automatically.
- Use soft delete for members, assets, liabilities, operations, valuations, and snapshots where applicable.
- Keep snapshots frozen by default.
- Separate current live calculations from historical snapshots.
- Support daily snapshots and monthly close markers.
- Do not automatically create a historical snapshot every time the user refreshes prices.
- Implement manual pricing and valuation first.
- Design pricing providers behind a common adapter interface.
- MVP provider strategy is no-key first: ECB for FX, CoinGecko keyless for crypto, Stooq best-effort for listed securities, and manual fallback.
- Allow future optional user-provided API keys without requiring them in the MVP.
- Track price source, price timestamp, fetch timestamp, freshness state, and stale reason.
- Keep dashboard usable offline with the latest known valid prices.
- FIRE/Coast FIRE is an MVP module but separate from the core net worth calculation.
- FIRE starts with manually entered monthly spending.
- FIRE excludes primary residence by default.
- FIRE asset eligibility is configurable per asset.
- The first implementation should be a tracer-bullet slice: members, assets/debts, ownership, liquidity, manual valuation, net worth calculations, snapshots, dashboard summary, and FIRE basics.
- Historical spreadsheet import is not a product feature in the MVP. It can be handled manually or with a one-off local script.
- No auth, local password, encrypted database, telemetry, cloud sync, or backup sync in the MVP.
- Google Drive sync is a future option, preferably via backups or sync packages rather than directly syncing a live SQLite database.
- The visual style should be an operational finance dashboard: dense, sober, precise, polished, and distinct from generic AI-generated dashboard aesthetics.

## Testing Decisions

- Tests should verify external behavior and domain invariants rather than implementation details.
- Domain core should have high-value unit tests because it controls net worth, ownership, liquidity grouping, snapshots, and FIRE calculations.
- Money and decimal handling should be tested with edge cases for rounding, FX conversion, ownership percentages, and mixed currencies.
- Ownership calculations should be tested for individual, household, and custom scopes.
- Net worth presentation modes should be tested separately: liquid, housing-inclusive, and gross/debt.
- Snapshot behavior should be tested to ensure historical snapshots remain frozen while current calculations can change.
- FIRE calculations should be tested for monthly spending, FIRE number, Coast FIRE required today, percent funded, and Coast FIRE age.
- Investment operation calculations should be tested for buy, sell, fees, weighted average cost, and selling more than recorded units with override.
- Validation should be tested for blocking structural errors and overrideable warnings.
- Pricing adapters should be tested through mocked provider responses, stale cache states, provider failures, and manual fallback behavior.
- Database repositories should have integration tests around migrations, soft delete, audit logging, and snapshot persistence.
- UI tests should cover the critical dashboard flows once the vertical slice exists: create member, create asset, assign ownership, save snapshot, switch scope, and view FIRE.
- End-to-end tests are useful after the first full slice exists, but should not block the initial domain model from being tested in isolation.

## Out of Scope

- Bank account integrations.
- Paid price providers or mandatory API keys.
- Generic Excel or Google Sheets import UI.
- Google Drive sync or cloud backup.
- Mobile app implementation.
- Local auth, PIN lock, or encrypted database.
- Dividend radar, dividend calendars, Gmail integration, or calendar integration.
- News feeds and "why my portfolio moved" explanations.
- Buy-zone decision support.
- Idealista scraping or automatic property valuation.
- Detailed fiscal calculations, Spanish tax reporting, FIFO/LIFO tax accounting, or tax forms.
- Budgeting and expense categorization.
- Full amortization scenario planning beyond the basic mortgage/debt representation required for net worth.
- Monte Carlo simulations, broad projections, or strategy comparison tools.
- SaaS deployment, billing, teams, public accounts, or hosted multi-user auth.

## Further Notes

- The user likes the idea of future projections, Google Drive sync, richer mortgage calculations, property revaluation models, mobile support, and dividend tooling, but these should stay out of the MVP.
- The spreadsheet currently contains useful historical monthly snapshots and physical metals data. Migration should be treated as a personal bootstrapping step, not as a reusable product requirement.
- The MVP should start with a vertical slice that proves the product loop: enter assets and debts, calculate net worth by scope, save snapshots, see progress, and calculate FIRE from manual spending.
- The project should remain personal-first but publishable: no personal data, absolute paths, or private spreadsheet assumptions should be committed as product defaults.
