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
**price provider**); it is not the unit, and not a figure the math reads. It is corrected
from the **holding**'s ficha, but only within its **persistence shape** — and the
correction re-applies none of those defaults, so a declared rung, value or price provider
survives it (ADR 0098).
_Avoid_: kind, type, asset type (overloaded — see Flagged ambiguities).

**Persistence shape**:
Which rows an **instrument** implies underneath a **holding**, and therefore the frontier
an instrument correction may not cross. Four: **manual** (value on the holding's own row,
hand-set or carried by an **appreciation rate** — cash, deposits, metals, vehicles,
property), **investment** (**derived** from an **operation** ledger and a unit price),
**connected** (value mirrored from a **connected source**'s positions, identity not the
user's to edit), and **debt**. Moving a holding between shapes is a re-**alta**, not an
edit: the target's **valuation method** would have no inputs (ADR 0098).
_Avoid_: family (that is the ficha's rendering surface, ADR 0095), kind.

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

**Managed portfolio** (cartera gestionada):
A roboadvisor-run portfolio (MyInvestor, Indexa, Finizens) the owner knows as one
balance but whose composition a manager decides. A grouping entity over live
**holdings** — never a holding itself: every member keeps summing into **net
worth** on its own, and membership is exclusive (a position lives inside one
portfolio). It carries its own cash — a sibling current-account member where
contributions wait for the investment threshold — and a **declared balance**
(saldo declarado): the reconciliation witness below. It can also be registered
WITHOUT enumerating its composition, in which case it carries an **undetailed
aggregate** below. An internal rebalance is a **traspaso** pair between members.
UI label: "cartera gestionada".
_Avoid_: nested holdings, container holding (its value would fight the sum),
grouping tag (no cash, no witness, no figures).

**Undetailed aggregate** (agregado «(sin detallar)») of a managed portfolio:
The ONE member a "solo saldo" alta creates to stand for a whole composition
nobody enumerated (#1551), worth exactly the **declared balance** typed at the
alta — so gross **net worth** is honest from minute one instead of under-counted
until the owner lists every fund. It is an ordinary stored-valuation holding (an
`other` instrument on the `market` rung: invested, sellable money), NOT an
**investment** — an investment's value is derived from **operations**, and the
owner has no participaciones, price or trade date to give. Progressive
substitution: as real members are added, the suggested value to leave it at is
`declarado − Σ detallado` over the INVESTMENT members only (the container's cash
was never part of the declared balance, and the aggregate itself is the figure
being replaced). Left at 0 € it is archived, ceremony-free — it keeps no ledger,
so the **trash exit** gate has nothing to refuse.
_Avoid_: a plug row (it sums like every holding), an investment with a fabricated
buy, treating it as the cash box (it is invested money, inside the careo).

**Declared balance** (saldo declarado) of a managed portfolio:
The last total the owner read in the manager's app, stored with its date as a
reconciliation **witness** — never a figure the book adopts, never a plug. Only
the latest is kept until a connector can produce the series. It is careed against
the derived value of the portfolio's INVESTMENT members, with the container's
cash left out: what the manager shows as "valor de mercado" is the funds (its own
cash sits in a separate box), and the cash box grows to `150 € + 0,5 %` of the
portfolio before being invested — more than ten points of drift generated by
design right before every contribution. Relative drift beyond 2 % raises a
`portfolio_reconciliation` data-health signal; the drift from NAV freshness alone
is ~0,3–1,2 %.
The cash box is the `cash` member and only it: a stored-valuation member that is
not cash (the "(sin detallar)" aggregate) is invested money and stays inside the
careo. The careo adds only what is held natively in the base currency — the
data-health signal has no FX layer, so careing a converted sum would let the
ficha and the signal reach different verdicts about the same cartera.
_Avoid_: careing it against the total including cash (compares two different
things); adjusting any figure to make it match.

**Portfolio return** (rentabilidad de la cartera):
How a **managed portfolio** has done, measured on its INVESTMENT members and
never on its cash: the container's cash has no cost of acquisition and does not
quote, so inside the rate it is drag that swings between 0 € and `150 € + 0,5 %`
with every contribution — and the manager's own figure excludes it too. It comes
from the shared subset engine every other return in the app rides (`subsetReturns`,
the one the per-asset-class decomposition uses), fed the same member values the
ficha's careo prints. **A traspaso between two members collapses into one residual
flow**, paired by its `transferId` and never by date: moving money from one fund
of the cartera to another is not capital the cartera received, and counting it as
such would inflate what it took to earn the gain. A half whose counterpart lives
outside the subset stays a real flow — that is capital leaving.
A member with no ledger — the **undetailed aggregate**, an alta with no operations
— is named as unmeasured, never folded in silently, and stays in the portfolio's
VALUE.
_Avoid_: an ad-hoc formula in the ficha; the cash inside the rate; reading the
figure as the manager's «plusvalía» when there have been reembolsos (the app's is
the total gain over everything contributed, the manager's the latent gain over
what the surviving participaciones cost).

**Summand** (sumando):
What the unified /patrimonio list is made of: either a loose **holding** or a
whole **managed portfolio** as one block. A grouping axis buckets summands, so a
portfolio is filed by its own aggregates — its dominant rung, its dominant
instrument — and is never taken apart by a view. Collapsed, its header IS the
summand; expanded, its members show as a breakdown that adds nothing, so
Σ summands = gross holds in both states.
_Avoid_: counting a block and its members in the same total; letting an axis
scatter a portfolio's members among the loose rows.

**Price provider**:
A service that supplies unit prices for investments. Each provider implements
the `PriceProvider` contract (`fetchPrice`). Wired providers:
Yahoo Finance (market tickers and metal futures — the default for liquid
holdings, ADR 0011), Finect (Spanish pension-plan and fund NAVs — the default for
term-locked holdings), CoinGecko (crypto, keyed by coin id e.g. `bitcoin`),
ECB (FX rates). A provider always reports the NAV's **own** currency; a non-EUR
quote is converted through the ECB rate, never passed through as euros (#1357).
A **retired provider** is one whose upstream is gone for good (Stooq, #1354): it
stays in the price-source vocabulary because stored rows carry it, is absent from
the registry, and its holdings keep their last known price with an actionable
reason instead of being refetched or silently frozen.
_Avoid_: data source, feed, API.

**Price source**:
The label recorded in the price cache to identify which **price provider**
supplied a given price (e.g. `"yahoo"`, `"finect"`, `"coingecko"`, `"manual"`, and
the retired `"stooq"` on rows written before #1354).
One provider maps to one source; fallback chains record the provider that
actually delivered the price, not the one that was tried first.

**Provider symbol**:
The lookup key sent to a **price provider** to fetch a price. For market
providers this is a ticker in Yahoo-format (e.g. `SAN.MC`, `VUSA.L`). For Finect
it is the product slug — a pension code (`N5394-Myinvestor…`) or an ISIN
(`IE00BDZVHT63-Fidelity…`) followed by its alias. Stored in
`investment_assets.provider_symbol`.
_Avoid_: ticker (too narrow — Finect codes are not tickers).

**ISIN**:
The International Securities Identification Number of an investment. Stored as
reference metadata only — it does not participate in price fetching. The
**provider symbol** is the sole lookup key. It is also the shared key of an
**exposure profile**. It identifies the **instrument**, never the **holding**: the
same fund at two brokers is two holdings carrying the same ISIN, so a match on it
resolves *what* the row is and leaves *which holding* open (ADR 0055, amendment
#1331). Reference metadata, but not optional in effect: an **investment** with a
**provider symbol** and no ISIN is an **orphan** — no **statement** can route to it, no
**exposure profile** is inherited, and nothing can decide that a broker's ISIN and its
own symbol name the same security. That state is a **data-health** signal
(`MISSING_INVESTMENT_ISIN`, #1489), never a blocked alta: a **pension plan** often has
no ISIN at all. The column accepts only what an ISIN is: every interactive write
validates the ISO 6166 check digit and refuses the rest (#1453) — a broker code in
this column would make the **exposure profile** key diverge from where the row was
registered.

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
**hedged** to the base currency. Shared and keyed by its identity — a **valid ISIN**
when present (ISO 6166-checked on both the registration and the lookup side, #1453),
else its **provider symbol** (a pension plan often has no ISIN), so two **holdings**
of the same security share one profile. It lives in the **control plane** as a global,
admin-curated catalog (ADR 0058): workspaces read it for **look-through** and never write
it. Like an **instrument** it is a descriptive label and not a figure the math reads: it
never touches **net worth**, **snapshots**, or **ripple recalculation**. Each breakdown
is a set of bucket→weight entries that need not sum to 100%. For geography and
currency the undeclared remainder is **unknown** coverage, never the `other` bucket —
`other` is a declared country (or currency) outside the named set. A reserved
`sin_region` / `sin_divisa` weight is the fraction with no country or currency (gold,
fund cash) and counts as **not applicable**. A breakdown over 100% is rejected. **Cash**
and **property** carry auto-derived profiles (from their instrument and the base currency);
coins are excluded (ADR 0017). Each profile also declares its **provenance** (#1508): its
**confidence** (`alta` a verifiable factsheet, `media` an issuer breakdown with a translated
taxonomy, `baja` a reading of the fund's mandate rather than its portfolio), its
**cut-off date** — the day the DATA is as of, never the day it was written, which is what
lets a vector age — and its **sources** as short free text. All three may be **sin declarar**
(null), which is the honest reading of a row nobody has sourced; none is ever guessed.
_Avoid_: instrument (the coarse kind — an exposure profile says what one specific security
contains), security master (implementation term), «fecha de actualización» for the cut-off
date (they are two different days).

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
figure. The base currency stays EUR; a **holding** denominated in another currency is
converted to EUR for aggregation at the dated ECB rate (spot for today), and when no rate is
available it is **excluded from the total and marked partial** — never summed as if it were
EUR, never a 1:1 guess (#1065). This currency-risk lens is exposure information, distinct
from that aggregation-time conversion.
_Avoid_: drill-down (the per-**position** second level is a different concept), passthrough.

**Attributed class** (_clase atribuida_):
An **asset class** that holds value today but not one euro of it in a product wholly of
that class — every euro is a sleeve inside mixed products. The **look-through** splits a
mixed product's value by its **exposure profile**, and the per-class return decomposition
splits its result the same way, so such a class inherits the mixed products' return: the
cash sleeves of two pension plans read «Efectivo +10,4%» when what rose was the plans'
equity (#1458). The domain measures how much of a class IS its own (`measuredValue`: the
value coming from holdings whose breakdown is that class alone) and MARKS the class that
owns nothing (`attributedOnly`); the display layer then withholds its rates and says why.
Value and weight stay — splitting today's euros by today's weight is what the attribution
genuinely knows. Not a data gap to close: there are no per-sleeve return series inside a
mixed fund, so what is decided here is how an attribution is PRESENTED, not how to measure
it better.
_Avoid_: calling it unclassified (that is the **coverage** gap — a holding whose class
nobody could resolve, which measures its own return whole), or reading the mark as a
quality score: renta variable can be 94% its own and still measure honestly.

**Operation**:
A buy, a sell, or one half of a **traspaso** against one **investment**: date, units,
price per unit, fees.
Always **stored in EUR** — the cost basis folds every operation of a holding into one
accumulator, so a ledger that mixed currencies would sum dollars as euros (which is
exactly what happened, #1401). An apunte the user has in another currency is therefore
**captured** in that currency and converted at the ECB rate of its **execution date** —
never today's — before it is written, keeping the original figures as its **capture**.
_Avoid_: writing an operation in the currency a broker states it in; and reading the
**capture** as optional detail — it is the only record of which rate was applied.

**Traspaso**:
Moving an **investment** position into another one without cashing it in — the
Spanish fund-to-fund transfer, tax-neutral by construction. Recorded as ONE move with
two halves: a `transfer_out` **operation** on the origin and a `transfer_in` on the
destination, sharing a transfer id that is exclusive to the pair. It is a **cashflow**
for each holding (the IRR of a position must see capital leaving or arriving, at that
day's market value) and never a realized gain: the latent gain travels with the
capital as the destination's **inherited cost**, which is why the pair cancels itself
at portfolio level on its date. Halves are always written together, never one at a
time — and removed together too, through the one gate that owns both rows (ADR 0082,
ADR 0083). What the user states is one date and, per half, two of its three figures:
the participaciones and the **importe** the confirmation prints — the ordinary case,
and then the unit price is derived, as on every buy and sell (#1544) — or the importe
and the unit price, and then the units are derived from them.
The one traspaso that is a single row is the **external entry**: a plan brought in
from another institution, whose outgoing half lives in that institution's ledger and
can never be written here. It enters by two doors — the add wizard's third answer to
«cuánto tengo» for the first movilización (#1541), and the ficha's «Traer de otra
entidad» for one that lands on a holding already on the book (#1518) — it carries a
`transfer_id` of its own so a reader finds one row and names it «desde otra entidad»
instead of reporting a broken pair, and its **inherited cost** is declared by the user,
defaulting to the importe that arrived. It may also declare an **inherited seniority**.
It is not a purchase, so it consumes no **contribution allowance**, and the
`transfer_integrity` data-health signal reads it the same way — an incoming row
standing alone is never reported as a broken pair.
UI label: "Traspaso".
In prose and on screen it is always "traspaso": "transfer" on its own collides with
the **workspace transfer** document. In code the two never meet — the transfer
document's types are `WorkspaceExport*`/`Exported*`, so a bare `transfer*` identifier
(`transferId`, `transferCostMinor`, `transferSeniorityAt`) belongs to this entry and
nothing else.
_Avoid_: calling it a transfer in prose or UI, sale + purchase (the modelling this
replaces — it realizes a gain that never happened), rollover, switch.

**Inherited cost**:
The acquisition cost the units of a **traspaso** carry over from the origin, stored on
the incoming half's row. The origin computes it once, at write time, as the
proportional slice of its own cost basis; from then on it is a fact of the
destination's ledger, so the position fold never has to read another holding's
history. Its absence on a `transfer_in` is a bug upstream, not a shape the ledger
supports. Because it is stored and never recomputed, what is written can drift from
what the origin sheds: a `transfer_integrity` data-health signal re-derives it from
the origin's own fold at ZERO tolerance, and reports the pairs that disagree along
with any `transfer_id` missing its outgoing half.
_Avoid_: carried cost, transferred basis.

**Inherited seniority** (antigüedad heredada):
The day the capital an **external entry** brought over started counting its age at the
previous institution — declared by the owner, on the incoming row, and never derived
(#1518). Only the external-entry doors ask for it, because an internal pair's origin
already has its dates in this book; the column itself lives on any `transfer_in`, since
a row with a `transfer_id` cannot say whether a counterpart exists. A movilización carries the seniority of the aportaciones that funded it, and
those sit in a ledger this book cannot read; the row's own `executedAt` is the day the
money LANDED, so deriving age from it would call rescatable capital blocked. Absent is
its own state and the default — «nadie lo ha dicho» — true of every row written before
the column existed, and nothing is backfilled into it. Refused only when it is not a
calendar day, or later than the day the capital landed; the landing day itself is
legal. **No figure reads it yet**: it is stored so that #1528 can derive which tramo of
a **pension plan** is available, at the one moment the owner has the old provider's
paperwork in hand.
_Avoid_: acquisition date (that is the **cost grade**'s question), available-from date
(that is derived, and #1528's).

**Cost grade** (grado del coste):
How honest an **operation**'s price is *as a cost*, stored on the row: `declared_cost`
(somebody stated it), `value_only` (nobody did — the price is what the position was
WORTH that day), or absent, which is the ordinary case and means the row is a real
dated movement whose price IS its cost. Same three grades, same es-ES words, as the
extracto reconcile's fidelity mark (decisión #1090, ADR 0048): «coste declarado»,
«sin coste real», «con movimientos». Only the **alta**'s synthetic apertura may carry
one — a real buy stating a grade would downgrade an observed movement to a
declaration. `derivePosition` folds it alongside the cost basis (worst grade wins, and
the taint clears when the units reach zero), and a `value_only` position shows the
mark WHERE its latent P/L would have gone rather than a `0,00 €` that reads as «ni
gana ni pierde». Never backfilled onto rows written before it existed: an old apertura
and a purchase made that day are the same row, and only the owner can tell them apart
(ADR 0097).
_Avoid_: fidelity (that word is the reconcile row's, for the same idea), cost
confidence, unknown-cost flag.

**Acquisition cost** (coste de adquisición):
What the owner DISBURSED to acquire a property, stored once on the holding — the
escritura price plus ITP/AJD, notaría, registro and gestoría. The housing twin of an
**investment**'s cost basis, and the counterpart of the **acquisition anchor**, which
records the market **value** that same day. The two genuinely differ: 48.000 € appraised
against 53.354,55 € paid is an 11,2 % that is spent at instant zero, so measuring a
property's result against the value would inflate it exactly where the entry costs are
largest (#1441). It is NOT part of any curve: **housing equity**, `valueHousingAtDate`,
the implied LTV and every **snapshot** read the anchors alone, so setting or clearing a
cost never triggers a **ripple recalculation** (ADR 0093). Absent by default and never backfilled
from an anchor — a property whose owner has not read the escritura shows no result at
all, rather than a fabricated 0 %. Financing (comisión de apertura, the bank's insurance)
is cost of the LOAN, not of the asset, and stays out (art. 35 LIRPF).
_Avoid_: purchase price, precio de adquisición (that is the anchor's **value**), cost
basis (reserved for **investment** units).

**Payout**:
Money a **holding** paid its owner on a date — a dividend, deposit or account
interest, or rent. A dated attribution record, not a figure: it never touches
**net worth**, the holding's value, **snapshots**, or **ripple recalculation** —
the cash it brought arrives through the ordinary **value update pass** of whatever
account received it, exactly as it does today. Asset-side and income-only: a one-off
payout models no costs (declare the one amount you consider yours — worthline is not
a budgeting app), and what a liability charges is already modelled by its
**amortization plan**. The one exception is a **payout schedule**'s **declared
expenses**, and even there no figure is netted — see that entry. Entered one-off
(a variable dividend) or derived from a **payout schedule** (rent). Like an
**operation** it is small and re-enterable, so it deletes directly with
confirmation and gets no trash.
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
enter those as one-off **payouts**. It may also carry **declared expenses**.
UI label: "Cobro recurrente".
_Avoid_: recurring income, planned payout (a schedule derives past truth; a plan
forecasts the future).

**Declared expenses**:
What a **payout schedule**'s income costs its owner, per occurrence and in the
schedule's own cadence — the agency, the IBI, the community fees, the insurance, the
maintenance, the empty months. Declared, never estimated, and its absence is a
distinct state from a declared zero: with no declaration nothing is derived from the
income at all (ADR 0076). It adds and subtracts no figure anywhere — net worth, the
**return**, the **delta breakdown** and the passive-income lens are all untouched, and
the lens stays **gross**. Its only consumer is the **rent-derived real return**.
UI label: "Gastos".
_Avoid_: net rent (that is the derived figure, not the field), budget, spending (this
is a cost OF an asset, not the user's **declared spending**).

**Rent-derived real return**:
The expected real return of a **real-estate** holding whose rent is declared: its
annual net rent (income minus **declared expenses**) over its value, substituting the
**housing** rung's default for that holding alone inside **FIRE progress**'s weighted
return. Only the housing rung, because rent is inflation-linked and a flat's real
appreciation is ~0 by construction — a deposit's interest is nominal and a fund's
dividend is only part of its return, so neither substitutes. The rate is
share-invariant (rent and value are both declared for 100 % of the property); only its
weight is scoped. Without **declared expenses** it does not happen: the gross yield is
never used, and the FIRE panel names it as the figure being withheld (ADR 0076).
_Avoid_: rental yield (ambiguous about gross vs net — this one is always net), cap
rate (property-investing jargon the app does not otherwise speak).

**Return mix**:
The slices behind **FIRE progress**'s weighted return: one row per **liquidity ladder**
rung with its share of the eligible pool, its assumed return and what it lends to the
total, plus one row per holding carrying its own **rent-derived real return** —
a subdivision of its rung, never a rung beside it. It is the same computation the rate
comes from, not a re-derivation, so the rate and its breakdown cannot disagree
(ADR 0077). Presentation-only: no total reads it. It is not shown when the user fixed
the return by hand, because it would then explain a figure nothing used.
_Avoid_: asset allocation (that is about weights alone, and about the whole portfolio,
not the FIRE-eligible pool), attribution (that word belongs to **payouts**, ADR 0054).

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
the **money-weighted return** (IRR), which keeps timing in. Not always measurable: a
sub-period whose flow dwarfs its opening value would contribute a factor at or below
zero, and the chain is then reported as unavailable with its reason rather than as a
percentage — a TWR below −100% is a broken chain, not a loss. See ADR 0040.

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

**Contribution allowance** (cupo anual de aportación):
A ceiling on what may enter **pension-plan** **holdings** during one calendar year, plus how
much of it the ledger has already spent. The **cap** is the user's declaration and never
a rule in the code — the legal limit depends on the year's law, on employer
contributions and on earned income, so encoding it would be tax advice with an expiry
date. Destinations are derived from the **instrument** (`pension_plan`), never ticked by
hand. What has been **consumed** is derived on every read from the real **buy**
**operations** of the year to those holdings — never from **planned contributions** or
their **reconciliations**, never from an **apertura**, and never stored. A sell gives no
room back. The whole thing adds no figure the net-worth math reads. UI label: "Cupo
anual de aportación". See ADR 0080.
_Avoid_: "límite fiscal" (worthline does not know one), "cupo consumido" as a typed
figure (it is derived).

**Statement**:
A file an external broker exports listing investment movements — one fund's or a
whole account's (e.g. a MyInvestor orders export). The user uploads it and declares
its broker; worthline reads it with a broker-specific parser, splits its rows by
**ISIN**, maps each group to an existing **investment** — or offers to create the
missing ones, prefilled by a live symbol lookup on the ISIN (the export carries no
fund name) — and merges each group into that investment's **operations**: matched
by date, the file winning where a date overlaps, operations whose date is absent
from the file left untouched (never deleted). Only executed rows load; pending or
rejected ones are skipped. The upload is previewed per fund — matched, new,
ignored, or **pending a choice** (an ISIN identifies the instrument, not the
holding: when two investments carry it — the same fund at two brokers — the user
names which one, and until then the fund stays out) — and applied all-or-nothing
over the funds the user includes. Uploaded from the portfolio (any mix of ISINs)
or from one holding, where every row must match that holding's ISIN. An investment
created without a **provider symbol** values at **cost basis** and carries an
overrideable **warning** until one is set, unless its position is closed. Distinct from an **Import** (a one-shot full-workspace replace) and
from a **connected source** (a live, read-only API mirror that owns its holdings):
a statement is a manual, file-based feed of operations, and each holding's value
still derives from its **price provider**. UI labels: "Cargar movimientos" (one
holding), "Importar extracto" (portfolio) — which is one door with two readers
(ADR 0071): the "Operaciones" tab reads this, the "Cuadro de amortización" tab
reads an **amortization schedule**.
_Avoid_: import (the full-workspace replace), pisar, sync (a connected source's refresh).

**Valuation anchor**:
A declared value of a **holding** at a specific date. Used to reconstruct historical
values for **snapshots**. Two kinds: **market appraisal** (reflects market movement,
a control point on the appreciation curve) and **improvement** (discrete value increment such
as a renovation, does not alter the underlying appreciation rate). One market appraisal
may additionally carry `kind = 'acquisition'` (#1437): the **acquisition anchor**, the
purchase that starts the property's history — editable by name in the UI, never deletable.
It is the property's market **value** on that day, never what acquiring it cost: what was
disbursed is the separate **acquisition cost** (#1441), and the alta names the anchor
«valor en la fecha de compra» for exactly that reason.
Its edit is a **reconstruction**, not a field change: moving its date or price redraws
every day up to the next **market appraisal** and re-ripples every **snapshot** since, so
it goes through a preview→confirm that says how much history the save rewrites, and the
confirm's verb says it (#1562, ADR 0070 §4). Editing it always keeps it a market
appraisal — an acquisition price is a total, never an **improvement** increment. Since
#1563 the assistant can also PROPOSE that edit (`propose_property_acquisition`): it is the
allowed side of the unvalidated-evidence frontier — a date and a price the card shows back
with the pair they replace — and confirming it goes through the same seam as the form.
_Avoid_: price point, historical value (too vague).

**Market appraisal**:
A **valuation anchor** that reflects what the market actually pays for the asset on
that date. When present, it becomes a control point that overrides the declared
**appreciation rate** in that segment; between control points the curve is sampled
on the first of each month by default (see **Valuation cadence**). The
appraised value is the total truth — it already includes any prior **improvements**.
The acquisition (marked `kind = 'acquisition'` since #1437; before that, inferred as
the earliest market appraisal) is when the property starts existing for historical
reconstruction, which is why an alta records the purchase where it happened when the user
knows it (ADR 0056) instead of stamping the day it was typed. The simple alta drawer does
stamp today (it never asks), and so does an alta dictated to the **assistant** with no
purchase declared. So when the acquisition lands on the day it was typed AND a
**liability** already declares an earlier start, the alta asks a non-blocking question
instead of silently amputating that history (#1561) — on the proposal card before
writing, or in the confirmation band right after.
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
balance holds the last cuota or anchor and moves only on the next, an **early
repayment** counting as an event on its own date (ADR 0031, #1291); see **Valuation
cadence** for the per-holding `interpolated` opt-in. Stored on the liability.
The liability's own **stored balance** (UI: "Saldo pendiente") is the figure only
while the model has no curve to walk: once an **amortization plan**, a **balance
re-baseline** or a **balance anchor** exists, the balance comes from the curve and
the stored field is dead — it is then neither shown nor writable on any surface
(neither the holding's ficha nor the "puesta al día", which lists every debt), and
the repair door is "Recalibrar con saldo real" or a new **balance anchor**
(#1290, #1334).

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

**Settlement amount** (importe de liquidación):
What a bank shows as "pending" on a loan: the **outstanding principal** plus the
interest accrued since the last cuota. Worthline's figure — everywhere, from net
worth to the cuadro — is the principal; the settlement amount is derived on demand
and shown as a labelled estimate beside it (#1292). Both are correct, and the gap
between them (a fraction of one cuota) is what makes a healthy loan look like a
bug when the user compares screens. The accrual prorates the running cuota's own
interest by elapsed days: no second day-count basis is introduced, so it can never
disagree with the schedule on screen. A **balance re-baseline** takes PRINCIPAL —
declaring the settlement amount there buries the accrued interest in the capital,
where it ripples forward and never comes out; the surface says so, warns when a
declared figure has that shape, and still lets it through.
_Avoid_: "saldo total", which names neither.

**Amortization schedule** (cuadro de amortización):
The bank's own document for an **amortizable** debt: a row per period with the
cuota, its interest/principal split and the outstanding balance, plus — in one
layout or another — the rate applied in each stretch. It is the OUTPUT of the
bank's model, never worthline's input format: what worthline reads out of it are
the **interest rate revisions** and **early repayments** it reveals, written over
an **amortization plan** that already exists (the plan's own conditions are never
rewritten). Because it prints both the causes and their consequences, it verifies
its own reading: the curve those events generate is measured against the balances
the same document declares, within the shared tolerance (ADR 0070), and the
verdict is shown before anything is saved. A stretch already covered by a
**balance re-baseline** stays governed by it (ADR 0056) — the schedule
reconstructs only the years the re-baselines do not cover, and retires none of
them. Enters by "Importar extracto", tab "Cuadro de amortización" (ADR 0071).
_Avoid_: extracto (the movements lane of the same door), cuadro alone when the
**amortization plan** is meant, or for the **computed schedule** below (the
bank's document is an input; worthline's is an output).

**Computed schedule** (the calculation trace's rows):
Worthline's own cuadro for an **amortizable** debt: one row per cuota with its
interest/principal split, the rate that governed it, the dated events that moved
it, and the balance it closed at. It is a READING of the balance curve, never a
second model of it — each row's closing balance IS the frontier the curve reports
on that date, so it cannot drift from the ficha (ADR 0090, #1596). The owner sees
one number for a debt; a cuadro that could disagree with it would be a second
opinion, not a second view. Read by the ficha, by the calculation trace an agent
consumes, and by the early-repayment simulation.
_Avoid_: **amortization schedule** (the bank's document, which is read IN), and
"the schedule" unqualified when which of the two is meant matters.

**Interest rate revision**:
A declared change to the annual interest rate of an **amortization plan** at a
specific date. The system recalculates the monthly payment from that date forward
with the new rate and remaining term. Entered one at a time in the debt's ficha,
or a whole document's worth at once by loading an **amortization schedule**.

**Early repayment**:
A declared payment against an **amortized** debt's principal at a specific date, partial
or total, that recalculates the schedule from that date forward — either lowering the
payment (term unchanged) or shortening the term (payment unchanged), chosen per repayment;
a total early repayment closes the debt. The balance drops on the payment's **own date**;
what is monthly is the reshaping of the plan, derived at the cuota the payment falls in
and first visible in the following cuota (#1291). Like an **interest rate revision** it is
a dated fact about the past and triggers a **ripple recalculation** (ADR 0012).
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
the modeled **valuation methods**: an **amortizable** debt steps on each cuota and on
each **early repayment**'s own date, a **revolving** debt on each **balance anchor**,
and a real-estate asset's drift is resampled on the first of each month. It is ignored
for market-priced holdings, whose daily movement is a real **price**, not
interpolation, and for **informal** debts, which
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

**Availability date**:
The day from which a **term-locked** holding's capital can actually be touched, as its
owner DECLARED it (`assets.available_from`, ADR 0100). The rung has always meant «locked
until a date» and never said which; this is that date. It is only ever a date — what is
available is DERIVED at read time from it and the day of reading, never stored, because a
stored euro amount expires every year and nobody revalidates it (ADR 0074). Absent means
«nobody has said», and nothing derives one: an alta by external transfer or an apertura
carries the date of the paperwork, not the seniority of the contributions behind it.
_Avoid_: «lo disponible» as a stored figure; deriving the date from an operation row.

**Liquidity breakdown**:
The split of a scope's holdings across the rungs of the **liquidity ladder**, each rung
shown as its share of **gross assets**. The **cash** and **market** rungs together are
**liquid net worth**.
_Avoid_: liquidity pyramid (implied a shape that never encoded amounts).

**FIRE progress**:
A scope's progress toward financial independence, calculated from FIRE-eligible assets,
declared spending, withdrawal-rate, return, and age assumptions. The **reference age**
is derived from the member's **birth date**, never typed (ADR 0073); the **target
retirement age** is the one age the user chooses. Its inputs are the user's
declarations, stored in a form that cannot expire; what the app measures or derives
elsewhere is a lens or a warning, never an input that overwrites one (ADR 0074). The
return is a weighted average of per-rung defaults, except for a holding whose income
is declared: there it is the **rent-derived real return** (ADR 0076). Every figure it
prints is shown with the inputs it came from, and each explanation is produced by the
same computation as the figure it explains, never by a second one (ADR 0077). Whether
the user's **immobilized capital** counts at all is one more of those declarations,
defaulting to yes; declaring it out measures every figure over the sellable side alone
and re-weights the return with what is left (ADR 0078).

**Coast FIRE**:
The point where the capital already saved would grow **on its own** to the **FIRE
number** by the **target retirement age** — a *state* of funding, not a level of life
to fund, so it never sits on the FIRE-levels rail beside Lean/Regular/Fat (ADR
0079). It names exactly three figures and they are not interchangeable: the *coast
requirement* (the FIRE number discounted back over the years left, the only one that is
a euro amount), the *age Coast is reached at* (the first year the trajectory projected
**with** the declared **savings capacity** crosses that requirement — the figure the
tick on the progress bar always implied), and, once the requirement is met, an
**achievement badge** instead of an age. All three exist only when there is compounding
room left before the target age: with a return of zero or below, or that age already
past, the requirement would land at or above the FIRE number and none of them is printed
— the screen says why instead. When the savings capacity tends to zero the arrival age
tends to the FIRE age, and that is correct: coast only buys slack if you save.
_Avoid_: "coast age" for the *zero-contribution* figure — that is the **FIRE age if
contributions stop**, a different question; "coast level" (it is not one).

**Sustainable spending**:
The inverse of the **FIRE number**: what a scope can spend without depleting its
patrimony. Always two halves, never one figure — the declared **net rents** (ADR 0076)
plus what the **sellable** side of the eligible pool supports at the withdrawal rate,
with the **immobilized** side named as what it leaves out. It has a perpetual reading
(the principal untouched) and, when the user declares a **final age** — how long the
capital must last, a declaration and never an estimated life expectancy — a depleting
one (the same capital annuitized from today's **reference age** to that final age). It is the headline for a scope
whose **retirement plan** is declared ordinary (ADR 0081).
_Avoid_: "safe spending" (a withdrawal rate is not a guarantee), "renta" (that is the
rent half alone).

**Retirement plan**:
Whether a scope's plan reads as FIRE or as an ordinary retirement — the user's
declaration, offered by the app when its signals point that way and never imposed (ADR
0081). It changes which question leads /objetivos and nothing else: every figure is
still computed. The threshold it is measured against, the **ordinary retirement age**,
is a user datum with a neutral default of 65, never legislation in code.
_Avoid_: "retirement mode" (there is no mode — same screen, same figures).

**FIRE age if contributions stop**:
The age today's capital alone would reach the full **FIRE number** at, with not one euro
more added — an honest and cheap answer to "what if I stop saving?". It was once labelled
«Edad Coast», which promised the age **Coast FIRE** is reached at and silently
contradicted the coast requirement printed beside it (ADR 0079). Whole years only: a
decimal on an age projected a decade out fakes a precision that is not there.
_Avoid_: coast age, Edad Coast.

**Measured savings**:
Net money the operations ledger shows going into investments over the trailing 12
calendar months, per month and **with its sign** — the one figure of the monthly flow
the app can produce without anybody typing it. It is never an input to **FIRE
progress**: it is the declared savings capacity's only witness, crossed against it as a
**data-quality signal** and vetoing **achievement badges** while it is negative
(ADR 0075). Below three months of ledger, or across mixed currencies, there is no
measurement and nothing is claimed.
_Avoid_: net savings (a different figure — the residual band of the **delta
breakdown**, computed from snapshots), savings capacity (the user's declaration),
savings rate (a ratio).

**Debt service**:
What the live amortizable debts of a scope cost per month — the sum of their cuotas in
effect today, weighted by the scope's ownership share, read off the **cuadro** and never
re-simulated (ADR 0099). The **flow** side of a debt, as against the outstanding balance
(its **stock**), which keeps netting against FIRE capital in its own rung. It is a
witness and never a subtraction: it is crossed against the **spending-includes-debt
declaration** as a **data-quality signal**, and no €/month figure on screen is reduced by
it. A `revolving` / `informal` debt has none — it declares a balance on a date, not a
schedule — and that absence is "unknown", not zero.
_Avoid_: cuota (one payment of one debt, not the scope's monthly total), debt burden,
DTI.

**Spending-includes-debt declaration**:
The user's answer to whether their declared monthly spending already covers their **debt
service** — `true`, `false`, or **absent**, and absent is a real state, not a `false`
(ADR 0099, ADR 0074). It decides nothing arithmetically and everything semantically: the
same coverage percentage means "you already live off your assets" or "you are a third
short" depending on it, so while it is absent the passive-income and sustainable-spending
cards say out loud that they do not know.
_Avoid_: includes mortgage (the debt service is not only the mortgage).

**Achievement badge**:
The "FIRE alcanzado" / "Coast FIRE alcanzado" mark on the home glance and the
/objetivos hero. A claim about the future made from today's capital, so it answers to
**measured savings**: while those are negative the badge is shown attenuated and worded
"alcanzado sobre el papel", with the measured figure named underneath — never hidden,
never green (ADR 0075).
_Avoid_: state pill (the visual component, not the concept).

**Birth date**:
A member's birth year and, optionally, birth month — the only stored age fact. Every
age FIRE prints (the age **Coast FIRE** is reached at, the **FIRE age if contributions
stop**, the years to target retirement, the three projected ages) is derived from it at
read time, so it cannot go stale (ADR 0073).

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
backfilled by a ripple — the one thing that adds dates beyond declared facts is
the **monthly floor** of the historical backfill, which is not a ripple. A snapshot generated for a past date is an ordinary **snapshot**,
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

**Monthly floor**:
The guarantee that reconstructed pre-signup history carries a **snapshot** on the
1st of every month some investment held units — the same monthly grid the
historical-price backfill uses (ADR 0033). Only the historical gap-fill / backfill
applies it, never a **ripple** and never the daily capture; it is a _union_ with
the dated facts' own dates, so an actively traded month keeps its finer detail.
Without it the resolution of that history measured how often the user **operated**
rather than how much time passed — four points in a busy March, a straight line
across a quiet one, next to a **housing** curve that is monthly by construction.
A month with no position (before the first purchase, after everything was sold)
gets nothing, and no price is fetched to build one: an unpriced month is valued at
cost basis. See ADR 0012.
_Avoid_: reading it as "every day is backfilled" — nothing fills the days between
the 1st and an **operation**; and note a floor point does become that month's
**monthly close** where no later snapshot exists.

**Monthly close**:
The last **snapshot** of a calendar month. Derived, never declared by the user. Per
**holding** it is the last snapshot _that holding appears in_ that month, so two
holdings can carry their close on different days; anything that sums holdings (a
class **return**, ADR 0040) aligns them by month rather than by exact date.

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
a stale or failed price, a stale or failed **sync**, a **sync** that has failed
attempt after attempt (#1226), missing configuration (FIRE,
a debt model), a declared savings capacity its **measured savings** cannot back
(#1449), sparse or gapped **snapshot** history, an unvalued **position**, a
manual value long without a **value update pass**, or a holding sitting in the
**trash** with units still held (#1365). Computed live per **scope**
from persisted state — never stored, never a figure. Carries a severity and,
where there is one, the holding, source, or scope it points at. One shared
collection feeds every consumer — the home's health block, the **agent view**,
and the **financial assistant** — so the human and the agent see the same
inventory. Signals that represent a deliberate choice are silenced with the same
**override** mechanism as warnings.
A signal is raised **once per thing the user would act on**, not once per row it
touches: unvalued **positions** are counted into a single signal per **connected
source** that says how many of how many and what is missing, because 77 identical
lines bury everything actionable next to them (#1356).
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
Recoverable does not mean free: while a holding is in the trash the next
**capture** stops counting it, so trashing one that still holds units drops the
**net worth** by its value with no **operation**, transfer, or **cash account**
movement recording where the money went. A **data-quality signal** flags that
state afterwards — friction only where there is money inside (#1365).

**Trash exit**:
What the **trash** door records about where a **holding**'s money went, for a
holding archived with units still on its ledger: `sold`, `transferred`, or
`mis_entry` (#1549, ADR 0085). Archiving such a holding is refused unless one of
the three is satisfied, at the store seam every writer passes — the ficha and the
**assistant**'s baja alike. `sold` and `transferred` are not permissions: they
name a movement already written (a closing **operation**, or a **traspaso** pair),
which is what left the position empty. `mis_entry` is the only declaration that
archives money still inside, and it says the value was never real — it is stored
on the row, shown in the Papelera, and it is what silences the signal. Cleared on
restore. A **managed portfolio**'s cash sibling has no exit at all: it cannot be
trashed while its portfolio lives — dissolving the portfolio releases it as an
ordinary account, with its balance intact.
_Avoid_: "motivo de borrado" (a reason is explanatory; an exit is enforced).

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

**Credentials**:
The secret a **connected source** authenticates with — an API key, plus a signing
secret where the provider needs one. Sealed at rest, never logged, never carried
in a URL, and never read back to the screen: a form asks for a replacement, it
never shows the current one. Credentials are the source's _key_, not the source
itself, so **rotating** them is a distinct act from **disconnecting**: the link,
its **positions**, and its history all survive a new key. A replacement is proved
against the provider _before_ it is stored, so a rejected one leaves the working
credentials standing rather than killing a live link with a typo. UI label:
"Cambiar credenciales".
_Avoid_: token (the short-lived thing minted _from_ credentials), password,
reconnect (that is disconnect + connect, which is what rotating avoids).

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
content × spot price, sourced from Yahoo metal futures + ECB — Stooq until #1354)
and its **numismatic value**
(Numista's estimate for that coin at its **grade**). Taken per coin, then summed
into the rolled-up holding. A coin whose metal is worth more than its collector
estimate is valued as metal, and vice-versa. When neither is available (a
base-metal coin Numista does not estimate), the value falls back to its
**purchase price**; absent even that, it is 0 and raises the existing
"value at 0" **warning**.
worthline never **assumes** a missing input to avoid that zero — an unknown
_ley_ (the metal's millesimal fineness, `fineness` in code) or weight is not
guessed at, because an invented melt value is worse than a visible gap. What it
does instead is name the missing input — the _ley_, the weight, the **grade**, the
estimate — in the **data-quality signal** and on the coin's own row, so a coin at
0 € is a task with an address rather than a silence (#1356).

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

**Sync run**:
One **sync** attempt, as a record: what triggered it (the twice-daily cron, a
person, connecting the source), when it started and finished, and whether it
succeeded. Kept as a short recent tail per source — a diagnostic breadcrumb, not
a ledger fact — so "why isn't this updating?" has an answer instead of a guess.
It records **health of fetch** (did the attempt run and work?), which is a
different question from **freshness** (how old is the figure on screen?): a run
that fails leaves the last good figure standing, so the two must be read
together. Only failures INSIDE the attempt leave a run at all — a fetch that
never gets off the ground (revoked credentials, provider down) is caught before
one is opened, and shows up only as the source's lapsed freshness.
The tail is also what makes a failure **persistent**: a single failed attempt is a
hiccup the connection's own page reports and nothing else, while two consecutive
failed attempts raise a **data-quality signal** — one failure that a later
successful attempt follows never alerts (#1226).
_Avoid_: job (the queue's unit of work, which may carry a run), sync (the act,
not the record of one attempt).

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

**Proposal amendment**:
A change the user asks for by chat over a **proposal** already on screen — «quita los
puntos posteriores a agosto», «ese saldo era otro» — expressed as a short list of
operations over the points that proposal already carries, never as a re-emission of the
whole series. It supersedes the draft it amends: a new proposal is prepared from the
old one and the old one is discarded, so its card cannot apply a series the user has
already corrected (ADR 0071). The operations are the chat's half of what the card's own
per-point controls do, so amending by chat and by hand cannot mean different things.
_Avoid_: edit (that is the card's own control), re-propose, update the proposal.

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
declaration**, a document's own closing figure, or what worthline's own curve computes
today — that a reconstructed history is measured against. The checksum for bulk historical
ingestion: the engine confirms the extracted **dated facts** add up to the anchor, so the
user can trust the whole in aggregate without checking each fact. Validates the endpoint,
not the intermediate curve, and **within a tolerance** rather than to the cent — a curve
derived from dozens of observed points cannot be expected to equal a stored figure exactly
(ADR 0070). There can be more than one anchor and they can disagree; agreeing with the
closest is enough, and an anchor the debt's own curve does not reproduce is reported as
suspect instead of obeyed. A disagreement is stated, never a locked door.
_Avoid_: baseline (overloaded with balance rebaseline), opening balance.

**Reconstructed history**:
Historical **dated facts** an assistant extracted from an uploaded document and proposed
(an **assistant proposal**), reconciled to a **reconciliation anchor** and stamped
`source: agent`. A distinct provenance tier — below broker-verified and hand-entered facts
— that worthline surfaces transparently and the user can correct point by point. Trust
comes from knowing what is reconstructed and being able to fix it, not from assuming the
extraction was right. It splits in two by whether a **reconciliation anchor** exists:
**reconciled** (an anchor exists and the checksum passed within its tolerance) and
**unverified** (no anchor —
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
- An **amortization plan** belongs to an **amortizable** liability; **interest rate revisions** and **early repayments** modify the plan from a date forward. An **amortization schedule** is the bank's printout of the result: worthline reads the revisions and repayments out of it and writes them onto the existing plan, never the other way round.
- A **balance re-baseline** attaches to an **amortized** liability at a date; the schedule re-derives forward from it and the pre-baseline past stays unmodelled — snapshots before it do not include the debt.
- A **balance anchor** attaches to a **revolving** or **informal** liability at a date.
- A **debt model** determines how a liability's historical balance is calculated: from an **amortization plan**, from **balance anchors**, or from a step function of anchors.
- A backdated **operation**, **valuation anchor**, or **balance anchor** triggers a **ripple recalculation** of existing **snapshots**; an **import** restores exported snapshots as-is and only fills gaps (ADR 0012).
- A **ripple recalculation** rewrites exactly one **holding**'s row and re-derives the five figures from the new row set; what differs between triggers is only how that holding is valued on the date (ADR 0091, #1601). Its frozen classification comes from the row itself, else the nearest capture of the same holding, else the live one — and a debt's rung follows the **housing** asset it secures whether or not that asset carries a row that date (#1436).
- A **historical price backfill** is the explicit, preview-then-confirm action that freezes a **price provider**'s past **unit prices** onto an **investment**'s monthly **snapshots** valued at **cost basis** — the _only_ path that rewrites historical unit price, never a side effect of a refresh; months the source cannot price stay gaps, never invented (ADR 0033).
- A **connected source** mirrors **positions** read-only and **projects** them into the portfolio as one **holding** per source per **liquidity tier** rung; the positions are sub-detail beneath that holding, the way **operations** sit beneath an **investment**. Such a holding's value is **derived** (computed from its positions, never hand-set), so it is excluded from the manual **value update pass** and re-valued through the **price provider** machinery.
- A coin's **purchase date** is a dated fact that ripples existing **snapshots** from that date forward (frozen at ripple time); a **sync** that finds a new trade ripples only from its date, while a mere price move never rewrites a past snapshot.
- Ownership of a **connected source** holding is worthline's own concern (the source has none): a normal **ownership split**, editable, defaulting to 100% the connecting **scope** member.
- A **demo mode** deployment shows the live app over a fictional, read-only workspace; a **persona** selects which fictional workspace is shown. Both are presentation concerns — they add no figure and change no calculation, and exist only in the demo build.
- **Sustainable spending, depletion version** distributes today's sellable capital over
  the years to the declared final age — and it is the ONE figure a declared **availability
  date** changes: no year is allowed to spend capital that year cannot touch, so the level
  payment is the smallest one every horizon can fund (ADR 0100). With nothing declared the
  arithmetic is byte-identical to the plain annuity. Term-locked capital with NO declared
  date is counted as available from year one, and the card says so rather than silently
  promising it.
- **FIRE progress** counts FIRE-eligible assets in the selected **scope** and excludes the primary residence plus any assets manually excluded from FIRE. The eligible pool is printed split by nature — what can be **sold in slices** (cash + market + term-locked) against what is **immobilized** (illiquid + housing), each side netting its own debt — and whether the immobilized side counts as FIRE capital at all is the user's declaration, defaulting to yes. Declaring it out takes those rungs out of the capital AND out of the return's weighting, through one predicate: dropping the capital while keeping the weight would quote a rate nobody's money holds (ADR 0078). The **sellable** side names how much of itself is **term-locked** capital: the rung stays sellable because a plazo does mature and a withdrawal rate is a decades-long rule, but the row no longer answers «sold in slices» without saying over what (ADR 0013, #1523).
- A figure worthline **derives** is printed with the inputs it was derived from, and its explanation is a projection of the same computation — never a second one beside it (ADR 0077). Hence the **return mix** ships with the rate, and a **reference age** ships with the **birth date** it came from. An explanation that would describe a figure the app is not using (a weighting under a hand-fixed return) is not shown at all.
- Not every plan is a FIRE plan, and for one that is not, "you are 31,5 % short" answers a question nobody asked. worthline **detects** that profile from declared data —a target retirement age at or above the user's own **ordinary retirement age**, or a Regular level the declared **savings capacity** never reaches— and **offers** to swap the question; the swap is the user's declaration, reversible, and it moves no figure (ADR 0081). The answer it leads with is the **sustainable spending**: the inverse of the FIRE formula, split into declared **net rents** plus what the **sellable** capital supports, with a depleting variant when the user says how long the capital must last. The public pension stays out of the engine — recurring income is already inside **savings capacity**, and a withdrawal rate stops applying once a pension covers part of the spending.
- **Coast FIRE** is a state of funding, not a level of life to fund, so it lives beside the progress bar whose tick draws it and never on the FIRE-levels rail (ADR 0079). Its age is the first year the projected trajectory crosses the coast requirement **with** the declared **savings capacity**; the age reached by leaving the capital alone is a different figure with its premise in its name (**FIRE age if contributions stop**). Every projected age prints in whole years.
- A **reference age** is never stored: it is derived from the member's **birth date** on every read, and a **scope** takes its oldest active member (the horizon that binds first). A typed age silently rejuvenated the member a year per year, always flattering the plan (ADR 0073).
- A **savings capacity** is the scalar the user declared, and the only monthly contribution the FIRE projection assumes (ADR 0074). In FIRE live final values — a deliberate simplification. Savings measured from **operations** is the form's default and the basis of a coherence warning, never the projection's input.
- An **exposure profile** is global reference data in the **control plane** catalog, keyed by **ISIN** (or **provider symbol**); **look-through** sums each **holding** weighted by its profile into the scope's **Exposure**, a present-time lens with explicit **coverage**. It is reference metadata — it adds no figure the net-worth math reads and never enters a **snapshot**.
- A **return** is derived per **investment** from its **operations** and **snapshots** — **simple gain** (realized + unrealized), **money-weighted** (IRR) and **time-weighted** (Modified Dietz over **monthly closes**) — present-time, never stored, never a figure the net-worth math reads (ADR 0040).
- A **payout** attaches to one asset **holding**; a **payout schedule** derives its past payouts as truth up to today, never beyond. Payouts feed the **return** (a recorded distribution enters the money-weighted cashflows and the realized **simple gain**) and the passive-income lens; they add no figure the net-worth math reads and never enter a **snapshot**. A schedule's **declared expenses** feed only the **rent-derived real return**, and only when declared: no declaration, no derivation — the gross yield is never used (ADR 0076).
- A **benchmark comparison** is a present-time lens (never a figure, ADR 0060) that reads a **benchmark series** cached monthly in a control-plane catalog. Globally it offers two real-terms, annualized lenses behind a toggle — **patrimonio real** (net worth deflated by CPI; includes contributions; ungated) and **rentabilidad real** (the invested sleeve's contribution-stripped **return** vs CPI; gated on returns) — and per **holding** it compares a fund's time-weighted **return** to the index it **tracks** (ADR 0039), never touching the net-worth math.
- A **delta breakdown** splits the change between two **snapshots** (normally **monthly closes**) into market movement, **payouts**, and **net savings** — the residual; it reads frozen snapshots, per-holding rows, **operations**, and **payouts**, and never writes history.
- A **data-quality signal** is derived live from persisted state; **warnings** are one category of it, and one shared collection feeds the home health block, the **agent view**, and the **financial assistant** alike.
- A **contribution plan** forecasts additions to **holdings**; its **occurrences** are **reconciled** by hand into real **operations** / value updates (never auto-matched, never auto-applied). It feeds a what-if, but adds no figure the net-worth math reads and never enters a **snapshot** (ADR 0041). It does **not** feed the FIRE projection's monthly savings: that is the capacity the user declared and nothing else (ADR 0074) — a plan row is one destination's planned addition, so summing rows measures a subset of savings, never the total.
- A **contribution allowance** declares a per-calendar-year ceiling for **pension-plan** **holdings** and derives what has been spent against it from the **operation** ledger — the ceiling is the user's datum, destinations come from the **instrument** not a tick, the consumption is never typed and never read off the **contribution plan**, and a counter fed by intention instead of truth would invite the very overshoot it exists to prevent (ADR 0080).
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
