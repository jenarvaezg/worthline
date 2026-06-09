# worthline Context

`worthline` is a personal-first, local-first net worth dashboard.

The product tracks net worth (total and liquid), housing equity, gross assets,
debts, ownership splits, liquidity tiers, frozen snapshots, and FIRE progress.
The MVP starts as a local web app backed by SQLite, with shared TypeScript
domain packages so a future mobile app can reuse the same calculations.

## Language

**Net worth**:
A scope's total assets minus its total debts, home equity included. The canonical
headline figure.
_Avoid_: total net worth (redundant qualifier), housing-inclusive net worth.

**Liquid net worth**:
Net worth counting only cash- and market-tier holdings — excludes retirement,
illiquid, and housing.

**Housing equity**:
Housing-tier assets minus the debts secured against them. A component of net worth,
not a separate framing of it.

**Gross assets**:
The sum of a scope's asset values before any debt is subtracted.

**Framing**:
Which figure — **net worth** or **liquid net worth** — is shown as the headline.
A framing re-labels the hero number; it never introduces a new figure. UI label: "Vista".
_Avoid_: presentation mode (implementation term).

**Scope**:
The set of members whose holdings a figure covers (the whole household, or one member).
_Avoid_: account.

**Liquidity tier**:
The accessibility class of a holding — cash, market, retirement, illiquid, or housing.

**Liquidity breakdown**:
The split of a scope's holdings across **liquidity tiers**, each tier shown as its
share of **gross assets**. The cash and market tiers together are **liquid net worth**.
_Avoid_: liquidity pyramid (implied a shape that never encoded amounts).

**Ownership share**:
A member's percentage stake in one holding.

**Ownership split**:
The full set of **ownership shares** on one holding; always totals 100%.
_Avoid_: ownership %, share (when the whole set is meant).

**Warning**:
A flag the dashboard raises about a holding that may need attention (e.g. an asset
left at value 0). Carries a severity: **blocking** or **overrideable**.

**Overrideable warning**:
A **warning** the user can mark intentional. A **blocking** warning cannot be dismissed.

**Override**:
A persisted acknowledgement that an **overrideable warning** is intentional, after
which that warning stops surfacing.

## Relationships

- **Net worth** decomposes into **gross assets** − **debts**.
- **Liquid net worth** and **housing equity** are partial views of **net worth**, sliced by **liquidity tier**.
- A **framing** chooses which figure headlines; **gross assets**, **debts**, **housing equity**, and **liquid net worth** are always-visible breakdown around it.

## Flagged ambiguities

- "total net worth" vs "housing-inclusive net worth" — were listed as distinct concepts but are the **same** figure (all assets incl. home equity, minus all debts). Resolved: canonical term is **net worth**; "housing-inclusive net worth" is retired.
- "liquidity pyramid" — the pyramid shape implied a ranked/proportional form it never had (only 3 of 5 tiers were even styled). Resolved: retired in favor of **liquidity breakdown**, where bar width encodes each tier's share of **gross assets**.

## Current Architecture

- Next.js powers the local web dashboard in `apps/web`.
- SQLite persistence lives in `packages/db`.
- Shared domain logic lives in `packages/domain`.
- Pricing provider contracts live in `packages/pricing`.

## Product Constraints

- Manual-first data entry.
- EUR base currency.
- Money amounts are represented as integer minor units.
- Decimal quantities, FX rates, and prices should use decimal strings.
- Local data must stay outside git.
- No auth, telemetry, cloud sync, or personal spreadsheet assumptions in the MVP.
