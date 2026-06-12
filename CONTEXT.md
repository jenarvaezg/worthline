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

**Holding**:
An asset or a debt in a scope's portfolio — the unit that **ownership splits** and
(for assets) **liquidity tiers** attach to. The unified list of a scope's holdings
is the portfolio. UI label for that list: "Patrimonio".

**Investment**:
An asset whose current value is derived — units held × unit price — never set by
hand. Units change only through **operations**; the unit price comes from a
**price provider** or a manual quote.
_Avoid_: editing an investment's value directly (it is a derived figure).

**Price provider**:
A service that supplies unit prices for investments. Each provider implements
the `PriceProvider` contract (`canFetch` + `fetchPrice`). Wired providers:
Stooq (market tickers), CoinGecko (crypto), ECB (FX rates). Decided but not
yet wired (ADR 0011, issue #106): Yahoo Finance (market tickers, primary once
wired), Finect (pension plan NAVs).
_Avoid_: data source, feed, API.

**Price source**:
The label recorded in the price cache to identify which **price provider**
supplied a given price (e.g. `"stooq"`, `"yahoo"`, `"finect"`, `"manual"`).
One provider maps to one source; fallback chains record the provider that
actually delivered the price, not the one that was tried first.

**Provider symbol**:
The lookup key sent to a **price provider** to fetch a price. For market
providers (Yahoo, Stooq) this is a ticker in Yahoo-format (e.g. `SAN.MC`,
`VUSA.L`). For Finect it is the plan code (e.g. `N5394`). Stored in
`investment_assets.provider_symbol`.
_Avoid_: ticker (too narrow — Finect codes are not tickers).

**ISIN**:
The International Securities Identification Number of an investment. Stored as
reference metadata only — it does not participate in price fetching. The
**provider symbol** is the sole lookup key.

**Operation**:
A buy or a sell against one **investment**: date, units, price per unit, fees.

**Valuation anchor**:
A declared value of a **holding** at a specific date. Used to reconstruct historical
values for **snapshots**. Two kinds: **market appraisal** (reflects market movement,
adjusts the interpolation curve) and **improvement** (discrete value increment such
as a renovation, does not alter the underlying appreciation rate).
_Avoid_: price point, historical value (too vague).

**Market appraisal**:
A **valuation anchor** that reflects what the market actually pays for the asset on
that date. When present, it becomes a control point for linear interpolation between
appraisals, overriding the declared **appreciation rate** in that segment. The
appraised value is the total truth — it already includes any prior **improvements**.
UI label: "Tasación de mercado".

**Improvement**:
A **valuation anchor** that represents a discrete value increment (e.g. a renovation
adding €10k to a house). Does not alter the interpolation curve or the
**appreciation rate** — it is a step-up on top of the market curve.
UI label: "Mejora".

**Appreciation rate**:
An annual percentage declared by the user to extrapolate a holding's value where no
**market appraisal** exists (before the first appraisal or after the last). Between
two appraisals, linear interpolation takes precedence. UI label: "Revalorización anual".

**Debt model**:
The calculation method for a liability's historical balance. Three kinds:
**amortizable** (French amortization schedule from declared conditions),
**revolving** (manual balance with **balance anchors**, linear interpolation between
them), and **informal** (partial payments as balance anchors, step function — no
interpolation). Stored on the liability.

**Amortization plan**:
The declared conditions of an **amortizable** debt: initial capital, annual interest
rate, term in months, and start date. The system derives the French amortization
schedule and can calculate the outstanding balance at any date. Supports
**interest rate revisions** for variable-rate loans.

**Interest rate revision**:
A declared change to the annual interest rate of an **amortization plan** at a
specific date. The system recalculates the monthly payment from that date forward
with the new rate and remaining term.

**Balance anchor**:
A declared outstanding balance of a **revolving** or **informal** debt at a specific
date. For revolving debts the system interpolates linearly between anchors; for
informal debts the balance stays constant until the next anchor (step function).

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

**Value update pass**:
A single pass where the user refreshes the values of every manual holding in one
form. UI label: "Puesta al día". Investments are excluded — their values are derived.

**Snapshot**:
A frozen capture, on a date, of a scope's net worth figures and of each holding's
value behind them (for investments, also units and unit price). Captured
automatically — at most one per scope per day, the day's latest capture winning.
Not a user act. Frozen means frozen against edits to the present: later edits,
renames, or deletions of a holding never alter what a past snapshot captured.
Declaring a dated fact about the past — a backdated **operation**, a
**valuation anchor**, a **balance anchor** — is new information, not an edit:
it generates the snapshot for that date and triggers a **ripple recalculation**
(ADR 0012).
_Avoid_: "guardar snapshot" as a user-facing action.

**Ripple recalculation**:
The re-derivation of existing **snapshots** after a dated fact about the past
is declared, modified, or deleted. Declaring at date D overwrites the snapshot
at D and recalculates the ones after D; modifying or deleting recalculates from
D inclusive. Only existing snapshots are re-derived — no new dates are
backfilled. A snapshot generated for a past date is an ordinary **snapshot**,
not a special kind. See ADR 0012.
_Avoid_: treating it as an exception to frozen snapshots (it incorporates new
information about the past; edits to the present still never touch history).

**Monthly close**:
The last **snapshot** of a calendar month. Derived, never declared by the user.

**Warning**:
A flag the dashboard raises about a holding that may need attention (e.g. an asset
left at value 0). Carries a severity: **blocking** or **overrideable**.

**Overrideable warning**:
A **warning** the user can mark intentional. A **blocking** warning cannot be dismissed.

**Override**:
A persisted acknowledgement that an **overrideable warning** is intentional, after
which that warning stops surfacing.

**Trash**:
Where deleted **holdings** wait, fully recoverable, until restored or
**hard-deleted**. Deleting a holding always lands it here first — the trash is
the only doorway to destroying one. UI label: "Papelera".

**Hard delete**:
The irreversible destruction of an entity's live data. Frozen **snapshots** are
never touched: history stays intact, so a hard-deleted holding still appears in
past captures. A **holding** hard-deletes only from the **trash**; a member only
while disabled and owning no share of any holding (trashed ones included); an
**operation** deletes directly with confirmation — it is small and re-enterable,
so it gets no trash. The audit trail of the destroyed entity is kept.
UI label: "Eliminar definitivamente".
_Avoid_: purge (suggests history is rewritten — it never is).

**Reset**:
The single act that empties the entire workspace — every holding, member,
snapshot, override, audit entry, and setting — returning the app to onboarding.
Unlike **hard delete**, the reset does erase history. UI label: "Borrar todo".

**Export**:
A portable, human-readable text capture of the entire workspace at a moment in
time — every live holding, member, ownership split, override, and setting, plus
the frozen **snapshot** history behind the figures. The manual stand-in for
backup and for moving between machines in an app with no sync. The audit trail is
deliberately left out. UI label: "Exportar".

**Import**:
Replacing the entire workspace with the contents of an **export**. Like a
**reset** it first erases everything — live data and history alike — but instead
of returning to onboarding it repopulates from the file, preserving the original
identities so the restored workspace is the same one, not a copy. All-or-nothing:
an export that fails validation changes nothing. UI label: "Importar".
_Avoid_: "pisar"; merge (an import never blends with existing data — it replaces).

## Relationships

- **Net worth** decomposes into **gross assets** − **debts**.
- An **investment** is a kind of **holding**; its value is always derived, never edited directly.
- **Liquid net worth** and **housing equity** are partial views of **net worth**, sliced by **liquidity tier**.
- A **framing** chooses which figure headlines; **gross assets**, **debts**, **housing equity**, and **liquid net worth** are always-visible breakdown around it.
- An **import** is a **reset** followed by loading an **export**: both erase the whole workspace, but a reset ends at onboarding while an import ends in a populated dashboard.
- A **valuation anchor** attaches to a **holding** at a date; **market appraisals** define the interpolation curve, **improvements** are step-ups on top.
- An **amortization plan** belongs to an **amortizable** liability; **interest rate revisions** modify the plan from a date forward.
- A **balance anchor** attaches to a **revolving** or **informal** liability at a date.
- A **debt model** determines how a liability's historical balance is calculated: from an **amortization plan**, from **balance anchors**, or from a step function of anchors.
- A backdated **operation**, **valuation anchor**, or **balance anchor** triggers a **ripple recalculation** of existing **snapshots**; an **import** restores exported snapshots as-is and only fills gaps (ADR 0012).

## Flagged ambiguities

- "total net worth" vs "housing-inclusive net worth" — were listed as distinct concepts but are the **same** figure (all assets incl. home equity, minus all debts). Resolved: canonical term is **net worth**; "housing-inclusive net worth" is retired.
- "liquidity pyramid" — the pyramid shape implied a ranked/proportional form it never had (only 3 of 5 tiers were even styled). Resolved: retired in favor of **liquidity breakdown**, where each tier's visual size encodes its share of **gross assets** (the specific encoding — bars, donut — is presentation, not language).

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
