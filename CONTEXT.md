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
**cash** and **market**. Excludes everything **term-locked**, **illiquid**, or **housing**
(pensions, deposits, collectibles, property, and other hard-to-sell holdings).

**Housing equity**:
The value of property (real-estate) holdings minus the debts secured against them. A
derived component of net worth, not a separate framing of it. Property sits on its own
**housing** rung of the **liquidity ladder**, but the equity figure is derived from the
property and secured-debt holdings themselves, never read off the rung — so it stays
stable however the ladder is bucketed.

**Gross assets**:
The sum of a scope's asset values before any debt is subtracted.

**Framing**:
Which figure — **net worth** or **liquid net worth** — is shown as the headline.
A framing re-labels the hero number; it never introduces a new figure. UI label: "Vista".
_Avoid_: presentation mode (implementation term).

**Workspace**:
A single self-contained financial world — one household's (or one person's)
**members**, **holdings**, **snapshots** and history. The unit of tenancy: every
figure is computed within exactly one workspace, and a workspace knows nothing of
any other. It carries a **mode** (individual or household) that sets whether figures
aggregate one person or several **members**, and it is the unit that is _shared_ —
access to a workspace can be granted to one or more **users**.
_Avoid_: account, tenant (implementation term).

**User**:
An authenticated identity that can sign in (e.g. via Google) and is granted access
to one or more **workspaces**. A user is not a **member**: a member is a person whose
holdings are tracked and weighted in net-worth math, whereas a user is simply someone
allowed to open a workspace and never appears in any figure. The same human may be
both — a member tracked in the household and a user who logs in — but the two are
separate records. Granting a user access (_inviting_) is independent of switching a
**workspace** to household **mode**: the first decides who may sign in, the second
decides whose holdings are aggregated.
_Avoid_: account, member, login, owner.

**Grant**:
A single row tying one **user** to one **workspace** with a role (`owner` today),
recording that the user may open that workspace. Access is the set of grants:
inviting a second user to a household is just another grant — no data moves,
because each workspace database is keyed by workspace, never by user. Lives in the
**control plane**, never inside a workspace database.
_Avoid_: permission, membership (a grant is access, not a tracked **member**).

**Control plane**:
The one small libSQL database that maps **users** → **workspaces** → **grants** and
records each workspace's database name/URL. It is the only place that knows which
workspace a signed-in user owns; each per-workspace database holds exactly one
`id = 'default'` row and knows nothing of users. On first login a user with no grant
is _provisioned_ a fresh workspace database here (ADR 0030).
_Avoid_: admin database, master DB.

**Scope**:
The set of members whose holdings a figure covers: the whole household, one member,
or a named group of members. A scope is always read _within_ one **workspace** — it
never spans workspaces.
_Avoid_: account.

**Member group**:
A named subset of active members that can be used as a **scope**. It is a reporting
lens over ownership shares, not a separate owner and not a portfolio container.
UI label: "Grupo".

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
**provider symbol** is the sole lookup key. It is also the shared key of an
**exposure profile**.

**Exposure**:
The composition of a scope's portfolio across axes — its largest **holdings**, its
split by **liquidity tier** and by **instrument**, its concentration, and (via
**look-through**) its underlying geography, currency, and asset class. A reporting lens
over current holdings, not a figure: it re-describes the portfolio, never changes
**net worth**.

**Exposure profile**:
The canonical description of what an **investment** actually holds underneath — its
breakdown by geography (a fixed set of world regions), by underlying currency, and by
asset class, plus the index it tracks, its TER, and whether its currency exposure is
**hedged** to the base currency. Shared and keyed by its identity — **ISIN** when present,
else its **provider symbol** (a pension plan often has no ISIN), so two **holdings**
of the same security share one profile. It lives in the **control plane** as a global,
admin-curated catalog (ADR 0058): workspaces read it for **look-through** and never write
it. Like an **instrument** it is a descriptive label and not a figure the math reads: it
never touches **net worth**, **snapshots**, or **ripple recalculation**. Each breakdown
is a set of bucket→weight entries that need not sum to 100% — the remainder is an implicit
_other_ (only what is known is declared) and a breakdown over 100% is rejected. **Cash**
and **property** carry auto-derived profiles (from their instrument and the base currency);
coins are excluded (ADR 0017).
_Avoid_: instrument (the coarse kind — an exposure profile says what one specific security
contains), security master (implementation term).

**Look-through**:
A scope's **Exposure** resolved down through its funds to the underlying geography,
currency, and asset class — the portfolio-level aggregation that sums each **holding**
weighted by its **exposure profile**. A present-time lens, computed live like the existing
**Exposure** breakdowns and never frozen into **snapshots**, so it stands apart from
historical reconciliation (ADR 0008). It always reports **coverage** — the share of
**gross assets** that carries a profile — so an unclassified remainder is surfaced, never
hidden behind a figure that pretends to cover everything. Because asset class is itself a
breakdown axis, a reader can restrict to equity and then read geography, answering "how
much US equity do I hold" without inventing the number. It also derives a **currency-risk**
lens — the unhedged non-EUR exposure, by currency — as information, never a change to a
figure (worthline has no FX layer and stays in EUR).
_Avoid_: drill-down (the per-**position** second level is a different concept), passthrough.

**Operation**:
A buy or a sell against one **investment**: date, units, price per unit, fees.

**Payout**:
Money a **holding** paid its owner on a date — a dividend, deposit or account
interest, or rent. A dated attribution record, not a figure: it never touches
**net worth**, the holding's value, **snapshots**, or **ripple recalculation** —
the cash it brought arrives through the ordinary **value update pass** of whatever
account received it, exactly as it does today. Asset-side and income-only: costs
are not modelled (declare the one amount you consider yours — worthline is not a
budgeting app), and what a liability charges is already modelled by its
**amortization plan**. Entered one-off (a variable dividend) or derived from a
**payout schedule** (rent). Like an **operation** it is small and re-enterable,
so it deletes directly with confirmation and gets no trash.
UI label: "Cobro".
_Avoid_: income (smells of salary and budgeting — in a net-worth app "ingreso"
reads as an incoming transfer), flow (direction-ambiguous, collides with the
IRR's cashflows), distribution (fund jargon — wrong for rent or interest).

**Payout schedule**:
A declared fixed recurrence of **payouts** on one **holding** — amount, cadence,
start, optional end. Like an **amortization plan** or an **appreciation rate**, it
is a declared parameter that _derives_ its past occurrences as truth — no
per-occurrence confirmation, and nothing derived beyond today: expected future
income is forecast, the **contribution plan** family's territory, not this.
Amending it re-derives the list live: a retroactive end date removes a dead tail
in one edit, and an **exclusion** removes a single occurrence (an unpaid month).
A variable amount never gets a schedule — estimating one would invent facts;
enter those as one-off **payouts**.
UI label: "Cobro recurrente".
_Avoid_: recurring income, planned payout (a schedule derives past truth; a plan
forecasts the future).

**Return**:
How an **investment**'s value has grown relative to what was put into it. worthline
reports three complementary measures — **simple gain**, **money-weighted return** and
**time-weighted return** — per **holding** and for the whole portfolio. Like **exposure**,
a return is a present-time derived figure: it is computed from **operations** and
**snapshots**, never stored, and never a figure the net-worth math reads. It carries its
honest limits: dividends/distributions enter only as declared **payouts** (a distributing
fund with none recorded understates), and any time-series measure starts at the first
**snapshot** — there is no return before history began.
_Avoid_: rentabilidad without saying which measure (the three are not interchangeable),
performance.

**Simple gain**:
A **holding**'s **realized** plus **unrealized** result, in money and as a percentage of
its cost basis. The plain "how much am I up". Not time-aware — +30% says nothing about
over how long. _Unrealized_ is current market value minus the cost basis of units still
held; _realized_ is proceeds minus the cost of units already sold.
_Avoid_: gain (unqualified — say realized / unrealized / total).

**Money-weighted return**:
The annualized rate (an **IRR** / XIRR over the **operation** cashflows plus current value)
that reflects the investor's own contribution timing — the "how am _I_ doing" number, and
the default **return**. Distinct from the **time-weighted return**, which strips timing out.

**Time-weighted return**:
The chain-linked sub-period return (**Modified Dietz** over **monthly closes**) that removes
the effect of cashflow timing — the measure comparable to a benchmark index. Distinct from
the **money-weighted return** (IRR), which keeps timing in. See ADR 0040.

**Contribution plan**:
A scope's set of **planned contributions** — its forward savings intentions. A forecast
layer: it never enters **net worth** or a **snapshot** (like an **exposure profile** or a
**return**, reference not a figure the math reads). It is the source of the derived monthly
savings the FIRE projection reads, replacing the lone manual figure when present. UI label:
"Plan de aportaciones". See ADR 0041.

**Planned contribution**:
A recurring intended addition to one **holding** — its destination (any holding, an
investment or a cash account), an amount in money _or_ units, a cadence (weekly, monthly,
quarterly or annual), a start and an optional end. An intention, not truth: the real purchase
is entered by hand when it happens — it may execute late, or at an unknown price.
_Avoid_: operation (the confirmed truth, which alone moves figures and history).

**Contribution occurrence**:
A single expected instance of a **planned contribution** on a date — a forecast row.
**Pending** until **reconciled**; never a figure the math reads.

**Reconciliation** (of a contribution):
Confirming a **contribution occurrence** by recording the real movement — a **buy**
**operation** for an investment, a balance **value update pass** for a cash holding —
pre-filled from the plan and corrected to reality, then linked. Manual and explicit:
worthline never auto-matches an independently entered **operation** to an occurrence.
States: **pending → fulfilled** (linked) or **skipped**; past pending occurrences are a
visible backlog.

**Statement**:
A file an external broker exports listing investment movements — one fund's or a
whole account's (e.g. a MyInvestor orders export). The user uploads it and declares
its broker; worthline reads it with a broker-specific parser, splits its rows by
**ISIN**, maps each group to an existing **investment** — or offers to create the
missing ones, prefilled by a live symbol lookup on the ISIN (the export carries no
fund name) — and merges each group into that investment's **operations**: matched
by date, the file winning where a date overlaps, operations whose date is absent
from the file left untouched (never deleted). Only executed rows load; pending or
rejected ones are skipped. The upload is previewed per fund — matched, new, or
ignored — and applied all-or-nothing over the funds the user includes. Uploaded
from the portfolio (any mix of ISINs) or from one holding, where every row must
match that holding's ISIN. An investment created without a **provider symbol**
values at its last operation's price and carries an overrideable **warning** until
one is set. Distinct from an **Import** (a one-shot full-workspace replace) and
from a **connected source** (a live, read-only API mirror that owns its holdings):
a statement is a manual, file-based feed of operations, and each holding's value
still derives from its **price provider**. UI labels: "Cargar movimientos" (one
holding), "Importar extracto" (portfolio).
_Avoid_: import (the full-workspace replace), pisar, sync (a connected source's refresh).

**Valuation anchor**:
A declared value of a **holding** at a specific date. Used to reconstruct historical
values for **snapshots**. Two kinds: **market appraisal** (reflects market movement,
a control point on the appreciation curve) and **improvement** (discrete value increment such
as a renovation, does not alter the underlying appreciation rate).
_Avoid_: price point, historical value (too vague).

**Market appraisal**:
A **valuation anchor** that reflects what the market actually pays for the asset on
that date. When present, it becomes a control point that overrides the declared
**appreciation rate** in that segment; between control points the curve is sampled
on the first of each month by default (see **Valuation cadence**). The
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
two appraisals, the appraised control points define the curve. By default the curve
is sampled on the first of each month and held flat through it (a **valuation cadence**
of `step`); the `interpolated` opt-in restores continuous daily drift. UI label:
"Revalorización anual".

**Debt model**:
The calculation method for a liability's historical balance. Three kinds:
**amortizable** (French amortization schedule from declared conditions),
**revolving** (manual balance with **balance anchors**) and **informal** (partial
payments as balance anchors). All three step between their events by default — the
balance holds the last cuota or anchor and moves only on the next; see **Valuation
cadence** for the per-holding `interpolated` opt-in. Stored on the liability.

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
An old debt may instead be declared by **current state** — outstanding balance
today, end date, and current rate _or_ payment (each derives the other, shown
back as an honesty check) — amortizing forward only from a **balance
re-baseline**, the original signing date kept as optional metadata and the years
before left unmodelled (ADR 0056).

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

**Balance re-baseline**:
A declared outstanding balance of an **amortized** debt at a date, from which the
French schedule re-derives forward — rate or payment given, term to the known end
date. The entry path for an old debt whose decades of **interest rate revisions**
and **early repayments** are unrecoverable, and the repair for one whose modelled
balance has drifted from the bank's reality. A dated fact: it ripples from its
date forward (ADR 0012) and never reconstructs the unmodelled past — snapshots
before it simply do not include the debt.
UI label: "Recalibrar con saldo real" (on an existing debt); the create-time form
is "Alta por estado actual".
_Avoid_: balance anchor (the **anchored** methods' concept — a re-baseline keeps
cuota semantics and the payoff projection).

**Balance anchor**:
A declared outstanding balance of a **revolving** or **informal** debt at a specific
date. By default the balance steps — it holds the most recent anchor's value until
the next — for both kinds; a **revolving** debt can opt into linear interpolation
between anchors via its **valuation cadence**. An **informal** debt is always a step.

**Valuation cadence**:
Whether a **holding** whose value comes from a model changes in **steps** on its event
dates (the default) or by **linear interpolation** between them (an opt-in). Applies to
the modeled **valuation methods**: an **amortizable** debt steps on each cuota, a
**revolving** debt on each **balance anchor**, and a real-estate asset's drift is
resampled on the first of each month. It is ignored for market-priced holdings, whose
daily movement is a real **price**, not interpolation, and for **informal** debts, which
are always a step. Set per holding in its advanced editing surface; absent means `step`.
A backdated change re-derives history like any parameter edit (**ripple recalculation**).
See ADR 0031.
_Avoid_: granularity, frequency (the **snapshot** cadence — at most one per day, ADR 0005 —
is a separate thing).

**Liquidity ladder**:
The ordered classification of holdings by how quickly and cheaply they convert to cash —
the dashboard's primary axis. Five rungs, most to least accessible: **cash** (available
instantly), **market** (realizable in days at minimal cost), **term-locked** (locked until
a date or age — deposits, pension plans), **illiquid** (sellable only with friction or a
haircut, over weeks to months — precious metals, vehicles, collectibles), **housing**
(property; sold over months, and tracked as its own rung because households reason about
the home and its mortgage separately from other illiquid assets). The two top rungs
together are **liquid net worth**.

**Liquidity tier**:
A holding's rung on the **liquidity ladder**. Finer real-world distinctions within a rung
(a pension vs a deposit; gold vs a vehicle) live in the holding's instrument, not in extra
rungs.
_Avoid_: treating retirement as a tier — it named why a holding is locked (a purpose), not
a level; pensions fall on **term-locked** (see Flagged ambiguities).

**Liquidity breakdown**:
The split of a scope's holdings across the rungs of the **liquidity ladder**, each rung
shown as its share of **gross assets**. The **cash** and **market** rungs together are
**liquid net worth**.
_Avoid_: liquidity pyramid (implied a shape that never encoded amounts).

**FIRE progress**:
A scope's progress toward financial independence, calculated from FIRE-eligible assets,
declared spending, withdrawal-rate, return, and age assumptions.

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
automatically — at most one per scope per day, the day's latest capture winning;
recorded whether or not anyone signs in, finalising at the day's close (ADR 0037).
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

**Delta breakdown**:
The split of a scope's net-worth change between two **monthly closes** into where
it came from: market movement (price and model movement of priced and modeled
holdings, exact per holding), **payouts** (recorded income), and **net savings**
(the residual). Computed from frozen **snapshots** (which capture each holding's
value), **operations**, and **payouts** — a lens that reads history and never
writes it. The same computation at holding granularity ranks the month's movers.
UI label: "Origen del cambio".
_Avoid_: performance attribution (a narrower industry technique — allocation and
selection effects — which this is not).

**Net savings**:
The residual band of the **delta breakdown**: the net-worth change not explained
by market movement or recorded **payouts** — what was added minus what was spent.
Honest by construction: a heavy-spending month is negative, and a transfer whose
two sides were updated in different months shows as noise in both (the
value-update lag, an accepted limit — never "fixed" by inventing transfer
matching). UI label: "Ahorro neto".
_Avoid_: aportaciones/contributions (implies only money in), savings rate (a
ratio — this is an amount).

**Warning**:
A flag the dashboard raises about a holding that may need attention (e.g. an asset
left at value 0). Carries a severity: **blocking** or **overrideable**. One
category of **data-quality signal** — the per-holding misconfiguration flags.

**Data-quality signal**:
A flag about how much the data behind the figures can be trusted: a **warning**,
a stale or failed price, a stale or failed **sync**, missing configuration (FIRE,
a debt model), sparse or gapped **snapshot** history, an unvalued **position**, or
a manual value long without a **value update pass**. Computed live per **scope**
from persisted state — never stored, never a figure. Carries a severity and,
where there is one, the holding, source, or scope it points at. One shared
collection feeds every consumer — the home's health block, the **agent view**,
and the **financial assistant** — so the human and the agent see the same
inventory. Signals that represent a deliberate choice are silenced with the same
**override** mechanism as warnings.
UI label: "Salud de datos".
_Avoid_: health check (implies a pass/fail gate), issue (overloaded), warning
(one category of signal, not the whole).

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

**Connector ingestion port**:
The shared, staged boundary through which an external feed presents stable,
normalized facts for preview, reconciliation, confirmation, and atomic application.
It covers both live **connected sources** and file-based statement feeds without
making their authentication, history, valuation, consent, or disconnect lifecycles
the same. A connector reports capabilities explicitly; it never writes the workspace
or receives its repositories. The application owns authorization, deduplication,
the **sync** run, audit, and commit. UI label: none (architecture term).
_Avoid_: connector SDK (suggests a shared full lifecycle), integration (too broad),
adapter registry (an implementation mechanism, not the boundary).

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

**Demo mode**:
A read-only public showing of worthline backed by fictional data, so the product
can be shown to people without exposing real holdings or running the live app.
Every figure and history is computed by the same engine as the live app — only
writing is turned off: declaring dated facts, editing, importing, resetting, and
reaching **connected sources** are all disabled, while reading, browsing, and
**exporting** stay live. The data is curated (never random) and frozen to a fixed
as-of date, so the dashboards and history stay internally consistent however long
after a build it is viewed.
_Avoid_: sandbox, sample mode, test mode (it is a presentation of the product, not
a place to try things — nothing the viewer does persists).

**Persona**:
One of the fictional profiles a **demo mode** visitor views — **joven**,
**inversor**, or **familia** — each a self-contained fictional workspace shaped to
show a different slice of the product (a starter saver; a markets-heavy investor; a
two-member household with a home and mortgage). Choosing a persona swaps the entire
workspace the viewer sees. A demo-only concept with no meaning in the live app.
_Avoid_: profile, demo user (overloaded — a persona is a whole fictional workspace,
not a login).

**Agent view**:
A read-only context surface over a **scope**'s financial facts, used by an agent
to inspect and explain the user's full portfolio picture without changing live data.
_Avoid_: connected source, account, financial advisor.

**Financial assistant**:
An AI-assisted experience that can explain the user's position, analyze trade-offs,
and recommend actions over the workspace's financial facts. It may advise in plain
language, but it does not execute changes, present itself as a regulated advisor, or
hide the assumptions behind a recommendation. When a fact is missing, it says so;
estimates are allowed only as explicitly labelled scenario assumptions. Its answers
surface the internal workspace facts or tool reads they relied on.
_Avoid_: financial advisor, robo-advisor, automatic manager.

**Assistant proposal**:
A draft set of workspace changes prepared by an AI assistant from chat, files, or
agent analysis. It is not live data: worthline validates it against the same domain
rules as manual input, previews its effects, and applies it only after explicit user
confirmation.
_Avoid_: import, sync, automatic fix, agent write.

**Assistant quick action**:
A one-click action suggested by the **financial assistant** that navigates, changes
the current analysis view, or runs another read-only analysis. In the first assistant
slice it never mutates workspace data; future write actions must become an
**assistant proposal** instead.
_Avoid_: shortcut (too generic), automation (implies unsupervised execution).

**Present-state declaration**:
What the onboarding wizard captures — a **scope**'s holdings and balances "as of today" —
recorded as opening facts dated today. Deliberately distinct from historical depth, which
is ingested later and separately, not typed into the wizard (ADR 0059). Doubles as a
**reconciliation anchor** for any history reconstructed afterwards.
_Avoid_: snapshot (that is the frozen daily capture), onboarding data.

**Reconciliation anchor**:
A present-day position or balance the user already knows — from a **present-state
declaration** or a document's own closing figure — that a reconstructed history must
reproduce end-to-end. The checksum for bulk historical ingestion: the engine confirms the
extracted **dated facts** add up to the anchor, so the user can trust the whole in
aggregate without checking each fact. Validates the endpoint, not the intermediate curve.
_Avoid_: baseline (overloaded with balance rebaseline), opening balance.

**Reconstructed history**:
Historical **dated facts** an assistant extracted from an uploaded document and proposed
(an **assistant proposal**), reconciled to a **reconciliation anchor** and stamped
`source: agent`. A distinct provenance tier — below broker-verified and hand-entered facts
— that worthline surfaces transparently and the user can correct point by point. Trust
comes from knowing what is reconstructed and being able to fix it, not from assuming the
extraction was right. It splits in two by whether a **reconciliation anchor** exists:
**reconciled** (an anchor exists and the checksum passed) and **unverified** (no anchor —
e.g. a holding no longer held, present only in the document — so the preview forces a look
at that item, since no checksum covers it).
_Avoid_: imported history (implies verified), synced history.

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
- A **balance re-baseline** attaches to an **amortized** liability at a date; the schedule re-derives forward from it and the pre-baseline past stays unmodelled — snapshots before it do not include the debt.
- A **balance anchor** attaches to a **revolving** or **informal** liability at a date.
- A **debt model** determines how a liability's historical balance is calculated: from an **amortization plan**, from **balance anchors**, or from a step function of anchors.
- A backdated **operation**, **valuation anchor**, or **balance anchor** triggers a **ripple recalculation** of existing **snapshots**; an **import** restores exported snapshots as-is and only fills gaps (ADR 0012).
- A **historical price backfill** is the explicit, preview-then-confirm action that freezes a **price provider**'s past **unit prices** onto an **investment**'s monthly **snapshots** valued at **cost basis** — the _only_ path that rewrites historical unit price, never a side effect of a refresh; months the source cannot price stay gaps, never invented (ADR 0033).
- A **connected source** mirrors **positions** read-only and **projects** them into the portfolio as one **holding** per source per **liquidity tier** rung; the positions are sub-detail beneath that holding, the way **operations** sit beneath an **investment**. Such a holding's value is **derived** (computed from its positions, never hand-set), so it is excluded from the manual **value update pass** and re-valued through the **price provider** machinery.
- A coin's **purchase date** is a dated fact that ripples existing **snapshots** from that date forward (frozen at ripple time); a **sync** that finds a new trade ripples only from its date, while a mere price move never rewrites a past snapshot.
- Ownership of a **connected source** holding is worthline's own concern (the source has none): a normal **ownership split**, editable, defaulting to 100% the connecting **scope** member.
- A **demo mode** deployment shows the live app over a fictional, read-only workspace; a **persona** selects which fictional workspace is shown. Both are presentation concerns — they add no figure and change no calculation, and exist only in the demo build.
- **FIRE progress** counts FIRE-eligible assets in the selected **scope** and excludes the primary residence plus any assets manually excluded from FIRE.
- An **exposure profile** is global reference data in the **control plane** catalog, keyed by **ISIN** (or **provider symbol**); **look-through** sums each **holding** weighted by its profile into the scope's **Exposure**, a present-time lens with explicit **coverage**. It is reference metadata — it adds no figure the net-worth math reads and never enters a **snapshot**.
- A **return** is derived per **investment** from its **operations** and **snapshots** — **simple gain** (realized + unrealized), **money-weighted** (IRR) and **time-weighted** (Modified Dietz over **monthly closes**) — present-time, never stored, never a figure the net-worth math reads (ADR 0040).
- A **payout** attaches to one asset **holding**; a **payout schedule** derives its past payouts as truth up to today, never beyond. Payouts feed the **return** (a recorded distribution enters the money-weighted cashflows and the realized **simple gain**) and the passive-income lens; they add no figure the net-worth math reads and never enter a **snapshot**.
- A **benchmark comparison** is a present-time lens (never a figure, ADR 0060) that reads a **benchmark series** cached monthly in a control-plane catalog. Globally it offers two real-terms, annualized lenses behind a toggle — **patrimonio real** (net worth deflated by CPI; includes contributions; ungated) and **rentabilidad real** (the invested sleeve's contribution-stripped **return** vs CPI; gated on returns) — and per **holding** it compares a fund's time-weighted **return** to the index it **tracks** (ADR 0039), never touching the net-worth math.
- A **delta breakdown** splits the change between two **snapshots** (normally **monthly closes**) into market movement, **payouts**, and **net savings** — the residual; it reads frozen snapshots, per-holding rows, **operations**, and **payouts**, and never writes history.
- A **data-quality signal** is derived live from persisted state; **warnings** are one category of it, and one shared collection feeds the home health block, the **agent view**, and the **financial assistant** alike.
- A **contribution plan** forecasts additions to **holdings**; its **occurrences** are **reconciled** by hand into real **operations** / value updates (never auto-matched, never auto-applied). It feeds the derived monthly savings the FIRE projection reads and a what-if, but adds no figure the net-worth math reads and never enters a **snapshot** (ADR 0041).
- An **agent view** reads a **scope**'s current portfolio, historical snapshots, **FIRE progress**, data-quality signals, and the calculation facts behind them; it defaults to the household **scope**, may be narrowed to one member or member group, preserves user-authored member, group, and holding labels, exposes context rather than recommendations, excludes secrets and transfer artifacts, never changes live data, and never refreshes or captures data as a side effect of being read.
- A **financial assistant** consumes the **agent view** and may recommend actions, but any workspace mutation still goes through an **assistant proposal** and explicit user confirmation.
- An **assistant quick action** may open an internal source, change the screen context, or launch another read-only analysis while keeping the assistant layer open.
- An **assistant proposal** may describe new or corrected **holdings**, **operations**, **valuation anchors**, **balance anchors**, **amortization plans**, or other dated facts; it never mutates them directly, and never edits **snapshots** as first-class user data.

## Flagged ambiguities

- "total net worth" vs "housing-inclusive net worth" — were listed as distinct concepts but are the **same** figure (all assets incl. home equity, minus all debts). Resolved: canonical term is **net worth**; "housing-inclusive net worth" is retired.
- "liquidity pyramid" — the pyramid shape implied a ranked/proportional form it never had (only 3 of 5 tiers were even styled). Resolved: retired in favor of **liquidity breakdown**, where each tier's visual size encodes its share of **gross assets** (the specific encoding — bars, donut — is presentation, not language).
- "kind" / `AssetType` (cash, manual, real*estate, investment) — treated as a holding's identity, but it bundles independent axes. Resolved: a **holding** is the unit and its "kind" is a \_derived label*; the real attributes are what the holding is (its instrument), how its value is obtained (set by hand vs derived from units × price), its **liquidity tier**, and whether it is owned or owed. "manual" and "cash" were the same stored-value holding; "investment" just means the value is derived.
- "liquidity tier" as a flat set {cash, market, retirement, illiquid, housing} — two were not liquidity levels: **retirement** named _why_ a holding is locked (a purpose) and **housing** named _what_ it is (an instrument). Resolved: the axis is an ordered **liquidity ladder** of pure accessibility rungs — cash, market, term-locked, illiquid. Pensions fall on term-locked, property on illiquid, and **housing equity** survives as a derived figure, not a rung. _(Superseded for housing — see next bullet.)_
- "housing as a rung" — removing it (above) left the home folded into **illiquid**, but the three dashboard surfaces disagreed on whether to show it separately: Evolución and the drilldown carved property out by holding id, while the **liquidity breakdown** did not, so the same home counted inside Ilíquido in one place and as its own band in another. Resolved (ADR 0022): housing is re-promoted to a fifth **liquidity ladder** rung so all surfaces bucket it identically by construction and the by-id carve disappears. The ladder is no longer "pure accessibility" — housing is a recognised carve-out households track separately. **Housing equity** stays a flag-derived figure and **FIRE** stays keyed on the primary-residence flag, so both remain decoupled from the rung.
- "debt model" (amortizable / revolving / informal) vs the asset-side valuation behaviours — the same axis. Resolved: a debt's model is its **valuation method** — amortizable = **amortized**; revolving/informal = **anchored**, differing only by interpolation (linear vs step). One concept (**valuation method**) spans assets and debts.
- "MCP for worthline" — MCP names an implementation channel, not a domain concept. Resolved: the product concept is an **agent view**, a read-only context surface for an agent.

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
- No telemetry or personal-spreadsheet assumptions. Auth and per-**workspace** cloud storage — originally excluded in the MVP — are now part of the **hosted, multi-user** product (see ADR 0030): a **user** signs in and is granted access to workspaces. They add no figure and change no calculation; the app stays local-first and runs identically with auth off.
