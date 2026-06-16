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
Net worth counting only holdings on the two liquid rungs of the **liquidity ladder** —
**cash** and **market**. Excludes everything **term-locked** or **illiquid** (pensions,
deposits, property, and other hard-to-sell holdings).

**Housing equity**:
The value of property (real-estate) holdings minus the debts secured against them. A
derived component of net worth, not a separate framing of it — and, since the
**liquidity ladder** recut, not a rung of its own: property sits on the **illiquid** rung
and its equity is surfaced as a figure.

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

**Instrument**:
What a holding actually is — e.g. a current account, term deposit, listed fund or share,
crypto, pension plan, precious metal, vehicle, property, mortgage, or loan. A descriptive
label that drives sensible defaults (its **liquidity tier**, its **valuation method**, a
**price provider**); it is not the unit, and not a figure the math reads.
_Avoid_: kind, type, asset type (overloaded — see Flagged ambiguities).

**Valuation method**:
How a **holding**'s value or balance evolves over time — the second axis after the
**liquidity tier**, defaulted by the **instrument**. Five methods: **stored** (set by
hand, refreshed in a **value update pass**); **derived** (units × unit price, moved only
by **operations** — what "investment" means); **appreciating** (a base value carried by an
**appreciation rate** and corrected by **valuation anchors** — property); **amortized** (a
French schedule from an **amortization plan** with **interest rate revisions** and **early
repayments** — the **amortizable** debt model, used for both mortgages and conventional
loans); and **anchored** (a balance reconstructed from **balance anchors**, linearly or as
a step — the **revolving** and **informal** debt models).
_Avoid_: treating "investment" as a kind (it is the **derived** method).

**Investment**:
An asset whose current value is derived — units held × unit price — never set by
hand. Units change only through **operations**; the unit price comes from a
**price provider** or a manual quote.
_Avoid_: editing an investment's value directly (it is a derived figure).

**Price provider**:
A service that supplies unit prices for investments. Each provider implements
the `PriceProvider` contract (`canFetch` + `fetchPrice`). Wired providers:
Yahoo Finance (market tickers — the default for liquid holdings, ADR 0011),
Stooq (market tickers, alternative), Finect (pension plan NAVs — the default
for term-locked holdings), CoinGecko (crypto, keyed by coin id e.g. `bitcoin`),
ECB (FX rates).
_Avoid_: data source, feed, API.

**Price source**:
The label recorded in the price cache to identify which **price provider**
supplied a given price (e.g. `"stooq"`, `"yahoo"`, `"finect"`, `"coingecko"`, `"manual"`).
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

**Statement**:
A file an external broker exports listing one **investment**'s movements (e.g. a
MyInvestor orders export for a single ISIN). The user uploads it against a chosen
investment and declares its broker; worthline reads it with a broker-specific
parser and merges its rows into that investment's **operations** — matched by
date, the file winning where a date overlaps, and operations whose date is absent
from the file left untouched (never deleted). Only executed rows load; pending or
rejected ones are skipped. Distinct from an **Import** (a one-shot full-workspace
replace) and from a **connected source** (a live, read-only API mirror that owns
its holdings): a statement is a manual, per-investment, file-based feed of
operations, and the holding's value still derives from its **price provider**.
UI label: "Cargar movimientos".
_Avoid_: import (the full-workspace replace), pisar, sync (a connected source's refresh).

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
rate, term in months, a **disbursement date** (firma — when the debt appears at its
initial capital and interest begins to accrue) and a **first-payment date** (the first
cuota; the balance amortizes from here and this date's day-of-month is the recurring
payment day). The balance is flat between the two. The system derives the French
amortization schedule and can calculate the outstanding balance at any date. The first
period's stub interest (disbursement → first payment, often more than a month) only
enlarges the displayed first cuota; it does not move the balance curve (ADR 0019).
Supports **interest rate revisions** for variable-rate loans and **early repayments**
(partial or total). A mortgage and a conventional loan use this identically — they
differ only as **instruments** (a mortgage is secured against a property), not in method.

**Interest rate revision**:
A declared change to the annual interest rate of an **amortization plan** at a
specific date. The system recalculates the monthly payment from that date forward
with the new rate and remaining term.

**Early repayment**:
A declared payment against an **amortized** debt's principal at a specific date, partial
or total, that recalculates the schedule from that date forward — either lowering the
payment (term unchanged) or shortening the term (payment unchanged), chosen per repayment;
a total early repayment closes the debt. Like an **interest rate revision** it is a dated
fact about the past and triggers a **ripple recalculation** (ADR 0012).
UI label: "Amortización anticipada".
_Avoid_: overpayment.

**Balance anchor**:
A declared outstanding balance of a **revolving** or **informal** debt at a specific
date. For revolving debts the system interpolates linearly between anchors; for
informal debts the balance stays constant until the next anchor (step function).

**Liquidity ladder**:
The ordered classification of holdings by how quickly and cheaply they convert to cash —
the dashboard's primary axis. Four rungs, most to least accessible: **cash** (available
instantly), **market** (realizable in days at minimal cost), **term-locked** (locked until
a date or age — deposits, pension plans), **illiquid** (sellable only with friction or a
haircut, over weeks to months — precious metals, vehicles, collectibles, property). The
two top rungs together are **liquid net worth**.

**Liquidity tier**:
A holding's rung on the **liquidity ladder**. Finer real-world distinctions within a rung
(a pension vs a deposit; a flat vs gold) live in the holding's instrument, not in extra
rungs.
_Avoid_: treating retirement or housing as tiers — they were instrument purposes, not
liquidity levels (see Flagged ambiguities).

**Liquidity breakdown**:
The split of a scope's holdings across the rungs of the **liquidity ladder**, each rung
shown as its share of **gross assets**. The **cash** and **market** rungs together are
**liquid net worth**.
_Avoid_: liquidity pyramid (implied a shape that never encoded amounts).

**Ownership share**:
A member's percentage stake in one holding.

**Ownership split**:
The full set of **ownership shares** on one holding; totals 100% for most
holdings. The exception is a holding co-owned with someone who is not a member: a
**real-estate** asset — and a debt **associated** to one — may carry a _known
partial_ split (e.g. 75% mine, the other 25% a non-member's), so its figures
reflect only the household's stake. Every other holding (cash, investments, a
standalone debt) totals 100%.
_Avoid_: ownership %, share (when the whole set is meant).

**Value update pass**:
A single pass where the user refreshes the values of every manual holding in one
form. UI label: "Puesta al día". Investments are excluded — their values are derived.

**Snapshot**:
A frozen capture, on a date, of a scope's net worth figures and of each holding's
value behind them (for investments, also units and unit price). Captured
automatically — at most one per scope per day, the day's latest capture winning.
Not a user act. Frozen means frozen against **cosmetic** edits to the present: a
rename or a deletion of a holding never alters what a past snapshot captured.
Declaring a dated fact about the past — a backdated **operation**, a
**valuation anchor**, a **balance anchor**, or an **amortization plan** — is new
information, not an edit: it generates the snapshot for that date and triggers a
**ripple recalculation** (ADR 0012). A **parameter edit** that changes how a
holding's value flows into history — its **amortization plan**, its
**appreciation rate**, or its **ownership split** — ripples the same way, without
declaring any new date. An amortization plan is the one fact that
generates a whole _series_: one snapshot per monthly payment from its start to
today, so a backdated loan shows its stepped paydown with no prior snapshots.
_Avoid_: "guardar snapshot" as a user-facing action.

**Ripple recalculation**:
The re-derivation of existing **snapshots** after a dated fact about the past
is declared, modified, or deleted. Declaring at date D overwrites the snapshot
at D (generating it if none existed) and recalculates the ones after D; modifying
or deleting recalculates from D inclusive. A dated fact generates a snapshot at
its own date; the lone exception that generates _many_ is an **amortization
plan**, which generates one at every monthly payment from its start to today (a
backdated loan's stepped paydown — PRD #109). No other intermediate dates are
backfilled. A snapshot generated for a past date is an ordinary **snapshot**,
not a special kind. An **ownership split** edit ripples along the **scope** axis
rather than time: it has no date, creates no new snapshot dates, and only
re-weights each existing per-member **scope** snapshot's row for that holding by
the new split. The household scope row is re-weighted too when the holding is
co-owned with a non-member (the household's combined share is then < 100%); it is
a genuine no-op only when the split sums to 100% within the household. It joins the
**amortization plan** and the **appreciation rate** as a parameter edit that
re-derives history, distinct from a cosmetic edit (a rename), which never does.
See ADR 0012.
_Avoid_: treating it as an exception to frozen snapshots (it incorporates new
information — a dated fact or a changed parameter; a purely cosmetic edit like a
rename still never touches history).

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

**Connected source**:
An external account worthline links to and mirrors — read-only — to obtain
**holdings** it would otherwise be entered by hand. The source owns the truth
(its catalogue, grading, and trades happen _there_); worthline reflects it,
never writes back, and refreshes by **syncing** on demand. A generic shape, not
a one-off: each source has an adapter (authentication + position listing) and a
projection into the portfolio. The first source is Numista (a numismatic
collection); the second is Binance (a crypto exchange), which adds the two cases
Numista never exercised — a source whose holdings are **valued live** (not frozen)
and one that **spans liquidity rungs**.
_Avoid_: integration, account (overloaded — see **scope**), import (a one-shot
full-workspace replace, not a live mirror).

**Position**:
A single line a **connected source** mirrors — what you hold, where it lives.
For Numista a position is a coin you own (its catalogue id, **grade**, and how
many), valued by a frozen candidate value; for Binance it is a token balance,
**valued live** (balance × unit price). A position is
not a **holding**: it is method-specific sub-detail beneath one, the way an
**operation** sits beneath an **investment**. Each position carries grouping
metadata (a coin's metal, a token's symbol) so the holding's detail page can
group them — a presentation lens, not a figure.

**Coin value**:
The value of one Numista **position**: the greater of its **metal value** (metal
content × spot price, sourced from Stooq + ECB) and its **numismatic value**
(Numista's estimate for that coin at its **grade**). Taken per coin, then summed
into the rolled-up holding. A coin whose metal is worth more than its collector
estimate is valued as metal, and vice-versa. When neither is available (a
base-metal coin Numista does not estimate), the value falls back to its
**purchase price**; absent even that, it is 0 and raises the existing
"value at 0" **warning**.

**Grade**:
The condition rating of a coin (e.g. VF, XF, AU, UNC), assigned by the user
_on Numista_, not in worthline. It selects which **numismatic value** estimate
applies. worthline reads it as part of a **position** and never edits it.

**Purchase date**:
The date a coin entered the collection, read from its Numista trade
(_compraventa_). worthline treats it as a **dated fact about the past** — like a
backdated **operation** — that ripples existing **snapshots** from that date
forward, placing the coin on the timeline when it was acquired. The value
applied is the coin's value _at the moment of the ripple_, then frozen:
worthline never fetches a coin's historical price, and later price moves never
rewrite a past snapshot. Numista's trade prices set _when_, not _how much_.

**Sync**:
Refreshing a **connected source** by re-reading its current positions and
re-valuing them. On demand, read-only, and bounded by the source's rate limits.
Distinct from a **snapshot** (a frozen capture worthline derives) and from an
**import** (a one-shot full-workspace replace).

**Projection**:
How a **connected source**'s **positions** roll up into the portfolio: one
**holding** per source per **liquidity tier** rung. Numista's coins are all
**illiquid**, so the collection is a single line; Binance spans rungs (spot and
flexible Earn on **market**, locked Earn on **term-locked**), so it surfaces one
line per rung, keeping the **liquidity breakdown** honest. Finer grouping (by
metal, by token) is a lens on the holding's detail page, not extra lines.

## Relationships

- **Net worth** decomposes into **gross assets** − **debts**.
- A **holding** sits on one rung of the **liquidity ladder**. A liability inherits the rung of its associated asset (netting against it); an unassociated liability sits on **cash** — it is a claim on liquid resources for its full balance.
- A liability **associated** to an asset inherits, by default, that asset's **ownership split** — copied when the association is established, then independently editable; it is not a live link (a later change to the asset's split does not move the liability's). Holding values are always declared globally (the whole holding) and weighted per **scope** by the split, so a debt on a home owned 65 % nets against it without the user computing shares by hand.
- A **holding** carries a **valuation method**; **investment** is just the **derived** method (value = units × unit price, never set by hand), not a kind of its own.
- **Liquid net worth** is **net worth** restricted to the two top rungs of the **liquidity ladder** (cash + market); **housing equity** is the equity of property holdings — both partial views of **net worth**.
- A **framing** chooses which figure headlines; **gross assets**, **debts**, **housing equity**, and **liquid net worth** are always-visible breakdown around it.
- An **import** is a **reset** followed by loading an **export**: both erase the whole workspace, but a reset ends at onboarding while an import ends in a populated dashboard.
- A **valuation anchor** attaches to a **holding** at a date; **market appraisals** define the interpolation curve, **improvements** are step-ups on top.
- An **amortization plan** belongs to an **amortizable** liability; **interest rate revisions** and **early repayments** modify the plan from a date forward.
- A **balance anchor** attaches to a **revolving** or **informal** liability at a date.
- A **debt model** determines how a liability's historical balance is calculated: from an **amortization plan**, from **balance anchors**, or from a step function of anchors.
- A backdated **operation**, **valuation anchor**, or **balance anchor** triggers a **ripple recalculation** of existing **snapshots**; an **import** restores exported snapshots as-is and only fills gaps (ADR 0012).
- A **connected source** mirrors **positions** read-only and **projects** them into the portfolio as one **holding** per source per **liquidity tier** rung; the positions are sub-detail beneath that holding, the way **operations** sit beneath an **investment**. Such a holding's value is **derived** (computed from its positions, never hand-set), so it is excluded from the manual **value update pass** and re-valued through the **price provider** machinery.
- A coin's **purchase date** is a dated fact that ripples existing **snapshots** from that date forward (frozen at ripple time); a **sync** that finds a new trade ripples only from its date, while a mere price move never rewrites a past snapshot.
- Ownership of a **connected source** holding is worthline's own concern (the source has none): a normal **ownership split**, editable, defaulting to 100% the connecting **scope** member.

## Flagged ambiguities

- "total net worth" vs "housing-inclusive net worth" — were listed as distinct concepts but are the **same** figure (all assets incl. home equity, minus all debts). Resolved: canonical term is **net worth**; "housing-inclusive net worth" is retired.
- "liquidity pyramid" — the pyramid shape implied a ranked/proportional form it never had (only 3 of 5 tiers were even styled). Resolved: retired in favor of **liquidity breakdown**, where each tier's visual size encodes its share of **gross assets** (the specific encoding — bars, donut — is presentation, not language).
- "kind" / `AssetType` (cash, manual, real*estate, investment) — treated as a holding's identity, but it bundles independent axes. Resolved: a **holding** is the unit and its "kind" is a \_derived label*; the real attributes are what the holding is (its instrument), how its value is obtained (set by hand vs derived from units × price), its **liquidity tier**, and whether it is owned or owed. "manual" and "cash" were the same stored-value holding; "investment" just means the value is derived.
- "liquidity tier" as a flat set {cash, market, retirement, illiquid, housing} — two were not liquidity levels: **retirement** named _why_ a holding is locked (a purpose) and **housing** named _what_ it is (an instrument). Resolved: the axis is an ordered **liquidity ladder** of pure accessibility rungs — cash, market, term-locked, illiquid. Pensions fall on term-locked, property on illiquid, and **housing equity** survives as a derived figure, not a rung.
- "debt model" (amortizable / revolving / informal) vs the asset-side valuation behaviours — the same axis. Resolved: a debt's model is its **valuation method** — amortizable = **amortized**; revolving/informal = **anchored**, differing only by interpolation (linear vs step). One concept (**valuation method**) spans assets and debts.

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
