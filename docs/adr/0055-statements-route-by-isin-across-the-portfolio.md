# Statements route by ISIN across the portfolio (partially supersedes ADR 0018)

## Context

ADR 0018 shaped the broker **statement** as strictly per-investment: one file, one
ISIN, uploaded against one chosen investment, with an ISIN guard that rejects a
file with mixed ISINs. That was the right v1 — it made a wrong-file slip an
obvious error — but it encodes an assumption the first real external user
immediately broke: brokers export the _whole account_. A MyInvestor "Órdenes"
export carries every order across every fund (a real sample: 153 orders across
26 ISINs, columns exactly as ADR 0018 documents, with **no fund-name column —
only ISIN**). Under the per-investment contract that file demands 26 manual
holding creations plus 26 filtered uploads; the user's verdict was "estamos
locos", and he is right: the file already contains everything needed to
reconstruct the full history.

What ADR 0018 got right and must survive: the merge-by-date semantics (file wins
on overlapping dates, absent dates never deleted), executed-rows-only,
preview-then-confirm, and the ripple discipline.

## Decision

A **statement** upload accepts any mix of ISINs and routes rows across the
portfolio:

1. **Group by ISIN.** The parsed rows split into per-ISIN groups. Each group
   resolves to one of three buckets in a single preview: _matched_ (an existing
   investment carries that ISIN — merge preview exactly as ADR 0018), _new_
   (no investment has it — a creation row), or _ignored_ (the user excludes the
   fund; not everything at a broker is worth tracking).
2. **Creation rows are prefilled by live symbol lookup keyed on the ISIN** (the
   add-holding wizard's search), because the export has no name column: the
   lookup turns `LU…` into a named, priced investment; when it resolves nothing,
   the name and provider symbol stay hand-editable and may be left empty.
3. **An investment created without a provider symbol is an honest, flagged
   state**: with no market price available, it values at **cost basis** — the
   ADR 0006 fallback (`deriveInvestmentValuation`: `marketValue ?? costBasis`;
   #183) — and raises an overrideable `MISSING_PROVIDER_SYMBOL` **warning**
   ("pending task" — set the symbol later; override it for hand-quoted funds).
   The warning applies to any investment without a symbol, not only imported ones.
4. **Confirm applies the included funds all-or-nothing.** ADR 0018's atomicity
   moves from "the file" to "the confirmed selection": one unresolvable ISIN is
   excluded and resolved later instead of blocking the other 25. Within the
   confirmation everything applies or nothing does.
5. **Entry points:** the portfolio level ("Importar extracto" on the portfolio
   and in the add-holding wizard) accepts any mix; the existing per-holding
   upload remains as the one-fund case of the same engine, its guard reduced to
   "every row's ISIN must match this holding" (backfilling an empty ISIN as
   today).
6. **Idempotent by construction:** re-uploading the same full export is a no-op
   — merge-by-date already guarantees it; creation rows match instead of
   duplicating on the second pass.

Merge semantics, executed-rows-only, sell handling, and ripple behavior are
unchanged from ADR 0018.

## Considered options

- **Portfolio-level ISIN routing with creation and per-fund selection (chosen).**
  One upload reconstructs an account's history; the real file drives the design.
- **Keep per-investment uploads, improve the rejection message.** Rejected: a
  better apology is still 52 manual steps for a 26-fund account.
- **Auto-create every unknown ISIN without a mapping step.** Rejected: nameless
  `LU…` holdings and untracked-on-purpose funds need the explicit
  match/create/ignore preview; silent creation buries mistakes.
- **All-or-nothing over the whole file.** Rejected: one unresolvable ISIN would
  hostage 25 resolvable funds; the selection is the honest atomic unit.
- **Value at last operation's price when no symbol.** Rejected (#684): diverges
  from the established ADR 0006 cost-basis fallback and would ripple through
  `atCostBasis` and snapshot semantics; cost basis is already honest and the UI
  does not over-promise market valuation.

## Consequences

- ADR 0018 is **partially superseded**: its single-ISIN entry contract (one
  file, one chosen investment, reject mixed ISINs) is replaced by this routing;
  its merge-by-date, preview-then-confirm, and ripple semantics remain accepted
  and are unchanged.
- `CONTEXT.md`'s **Statement** entry is re-worded: a statement lists one fund's
  or a whole account's movements; per-holding upload is the one-fund case.
- The `MISSING_PROVIDER_SYMBOL` warning lands on the existing warnings system
  (per-holding, overrideable) and flows into data-quality signals automatically
  when the shared engine unifies them.
- Real broker exports never enter the repository (public repo): test fixtures
  are synthetic files with the same shape.

## Amendment (#1348): a closed position has no pending task

Decision 3 above says a symbol-less investment "raises an overrideable
`MISSING_PROVIDER_SYMBOL` warning — a pending task". The pending task exists only
while the position is **open**. A fund sold in full is kept as history: it holds
no units, contributes nothing to today's figure, and no symbol would ever be
looked up for it — yet the warning regenerated on every daily read, buried the
actionable ones (open holdings with no price), and pushed the user to trash
legitimate history just to silence the noise.

So the warning is not emitted for a **closed** position: a `derived` holding that
has at least one recorded operation and whose net units are within
`CLOSED_POSITION_UNITS_EPSILON` (`0.0001`, dust from a rounded sell) of zero.
Two boundaries matter:

- **No operation yet ≠ closed.** A freshly created investment also holds 0 units,
  but its missing symbol is a genuine pending task, so it still warns. The rule
  keys off "has a ledger that nets to ~0", not off "holds nothing".
- **Reopening restores it.** A new buy puts units back and the warning returns —
  no state is stored, the filter is derived from the ledger on every read.

One definition, `isClosedPosition` in `warnings.ts`, and every consumer that
*shows* the warning feeds it the ledger it already has: the home hero and the
agent view's `get_data_quality` through the shared `#654` engine — where
`netUnitsByAssetId` is a **required** input precisely so neither can drift — plus
the /patrimonio board, the holding ficha, and `get_holding_detail`.

Two `collectWarnings` callers are deliberately left unfiltered, and neither shows
anything: `captureNetWorthSnapshot` writes `snapshot.warnings` into each frozen
capture, and `prepareDashboardState` fills `DashboardState.warnings`. Nothing
renders either field today. Threading the ledger into snapshot capture would
change what every historical reconstruction path persists (the ripple engine, the
gap-fill, the backfill) for a column no surface reads — so the closed-position
filter stops at the read surfaces. If either field ever gains a reader, it must
take the ledger at that point, not grow a second filter.

### Boundaries this filter deliberately does not police

- **Price freshness rides along.** `STALE_PRICE` / `FAILED_PRICE` are the same
  noise one step over: a sold-out position keeps its price-cache row, so its
  quote goes stale forever, and `FAILED_PRICE` is `high` — it turns the home
  hero red over a holding worth 0. A price nothing multiplies cannot compromise
  today's figure, so the data-quality engine skips those two for a closed
  position as well. This is why the agent view folds net units for **every**
  `derived` holding rather than only the symbol-less ones: a map narrowed to one
  code's candidates would under-populate the moment a second code reads it.
- **An over-sold ledger reads as closed.** `derivePosition` clamps a sell that
  exceeds the units held, so a mis-imported ledger nets to `0` and is silenced
  here. That is accepted, not ignored: over-selling raises its own position
  warning ("la venta de N unidades supera las M disponibles"), which is the
  honest signal for a data problem — a missing price symbol is not.

Related: the connected-source exemption (#685) is the same shape — a Binance or
Numista holding never carries a provider symbol because its source prices it.

## Amendment (#1331): an ISIN identifies the instrument, not the holding

Decision 1 above resolves a group to _matched_ when "an existing investment carries
that ISIN". That sentence hides an assumption this ADR never stated and the data model
never enforced: that **at most one** holding carries it. `investment_assets.isin` is
not unique, and the same instrument at two brokers is a legitimate, real portfolio —
the father's `IE00B1G3DH73` lives both in a CLOSED position of an old broker (97,65
uds bought and sold in full) and in the LIVE Cartera Indexada holding that keeps
receiving contributions.

Under a first-wins index, the second claimant is unreachable and the first wins by
creation order — which in that real case is the dead holding. So:

- **An ISIN (or the provider symbol that plays its role for pension plans and crypto,
  #695) identifies the instrument. It does not identify the holding.** A key claimed
  by more than one holding resolves the instrument and leaves the holding open.
- The assistant's S1 matcher (`holding-matcher.ts`, PRD #1103) indexes **every**
  claimant and, when a key has several, degrades the match from `strong` to a ranked
  proposal `ambiguous` flag included: the row still defaults to the best claimant, but
  it is never "safe to apply unattended", and the preview names how many holdings
  share the key so the user picks. The reconcile preview already knew how to reassign
  a candidate, so no new surface was needed.
- **Ranking, never resolution.** Two cheap disambiguators order the claimants: the
  holding whose name the document also matches, then a live position before a closed
  one. Closed is `isClosedPosition` — the one definition from the #1348 amendment
  above, net units over a real ledger; a value-is-zero guess would demote precisely
  the live-but-unpriced holding it exists to promote (a symbol-less investment values
  at cost basis, decision 3).
- **The document's own scope is not available.** "Which broker/portfolio is this row
  from" would be the strongest disambiguator, but the extraction contract carries no
  broker or scope per holding, so it is not part of the ranking today.

The statement router (`resolveStatementImportBuckets`) carried the same first-wins
index, and there it can `delete`/`overwrite` operations of the holding it picked —
closed in **#1366**, see the amendment below.

## Amendment (#1366): the router asks instead of picking

The amendment above fixed the assistant's matcher and left the statement router with
the assumption it had just retired. On this surface it costs more: a _matched_ bucket
does not only add, it carries `deletes` and `overwrites` (ADR 0018 — "the file wins on
the dates it covers"), so a duplicated ISIN meant the upload could rewrite the closed
broker's history, or the live one's, chosen by creation order.

The same rule, adapted to a surface where the choice must be **asked**:

- **Every claimant is indexed** and a bucket carries `claimants`, each with **its own
  merge plan** — the plan is only meaningful against one ledger, so the preview shows
  the chosen holding's counts and position impact, not a default's numbers next to
  another holding's name. The flat `assetId`/`mergePlan` fields remain the best-ranked
  claimant, a default for rendering, never a resolution.
- **Ranking is the same pair of disambiguators** as the matcher's `rankStrongClaimants`
  (the file's own name first, then live before closed), with `closed` read from the
  ledger the router already holds. Ties keep portfolio order. The key normalizers both
  surfaces depend on now live in one module (`matching-keys.ts`): they must read "the
  same key" identically or the same file resolves differently per door.
- **The importer asks.** An ambiguous identifier renders as a choice ("¿cuál de tus
  inversiones es?"), starts excluded and cannot be included until it is named — a
  pre-checked best candidate would smuggle back the very by-order pick this exists to
  stop. The confirm re-derives the buckets and refuses a choice that no longer names
  exactly one claimant, so a portfolio that changed under an open preview blocks
  instead of writing.
- **The chat leaves it out.** `propose_statement_import` has no surface on which to ask,
  so an ambiguous identifier is excluded and the proposal card says which one and where
  to resolve it — decision 4 applied verbatim: one unresolvable identifier is excluded,
  never a hostage to the other 25, and never a silent drop.

What is deliberately NOT done: inferring the holding from the document's broker (the
extraction contract still carries no scope, as the amendment above notes), and blocking
the whole upload on one ambiguous identifier.

## Amendment (#1349): the chat fills an identity hole, it never creates the pair

The amendment above settles what a duplicated key MEANS once it exists. #1349 asks
the other half: who may bring one into existence. The chat now has a way to write
an instrument's identity — the ask that follows a data audit is «este fondo no
tiene ISIN, póngselo», and until then the model had no path and improvised one
(it filed a maintainer alert as if it were a support ticket, #1347).

The answer is asymmetric, and the asymmetry is the decision:

- **An empty field may be filled from the chat.** Writing into a hole cannot
  reprice a holding as a different instrument, and the guards that remain are
  cheap: the ISIN's own checksum, and the #1329 rule that a symbol must not turn
  an alta «por valor total» into one share.
- **A field that already has a value is not changed from the chat, indefinitely.**
  Replacing an ISIN or a symbol reprices the position as another fund and can hand
  a statement the wrong holding to overwrite. That edit stays on the ficha, where
  the whole holding is on screen.
- **An ISIN another holding already claims is refused, naming the claimant.** The
  legitimate pair (the same fund in two brokers, one closed and one live) is real
  — and it is precisely why the chat does not create it blind. A human makes that
  pair on the ficha, seeing both. This is what un-blocked #1349 from #1366: while
  the importer's router still first-won, the chat had already stopped being a
  source of the pairs that triggered it.
- **A duplicated provider SYMBOL is not refused**, and the asymmetry is the whole
  point of the amendment above. A symbol is a pricing route: the same ETF at two
  brokers shares it, both holdings value correctly off the same quote, and nothing
  routes a document by it. What a duplicated ISIN does and a duplicated symbol does
  not is give the importer a second claimant for a row it may `overwrite`. Refusing
  the symbol would send the most common fill of all — «este fondo no se actualiza» —
  to the ficha for no gain.

The rule is one pure function (`resolveInstrumentIdentityFill`) called twice: when
the card is drafted, and again inside the apply. A draft carries no lock, so
without the second call two proposals in flight — or a ficha edit between drafting
and confirming — would let «only fills holes» be true at preview time and false at
write time. The #1329 value-only guard makes the same round trip, which is why its
module moved into the domain: an operation deleted on the ficha between drafting
and confirming is enough to turn a curated ledger back into the 1-participación
opening, and the apply lives in `packages/db`, where the web app is out of reach.

## Amendment (#1748): a statement routes by TYPED identifier

Decision 1 above says "group by ISIN", and #695 had already widened that in practice
to "or whatever key the plantilla carries". Both sentences hide the same assumption:
that an identifier is a STRING, so two identifiers are the same when their characters
are. A Spanish pension plan has no ISIN — its identifier is the código DGS `N####`
(PRD #1741) — and under a flat space by value that code would meet the same five
characters sitting in an ISIN column, or in a finect symbol, and match. Those are
three different registers.

So the routing key carries its **namespace** (`packages/domain/src/matching-keys.ts`,
the module both doors already share, #1366):

- **`isin:…`, `dgs:N####`, `sym:<símbolo>`.** A holding claims the key of the identifier
  it DECLARES (the typed pair of #1743) plus one for its provider symbol; a document row
  claims the key of its typed pair when the reading states one (#1747), else the key its
  raw identifier is **classified into by shape at the seam** — an ISIN with its check
  digit, a normalized `N####`, and everything else a symbol.
- **A key only ever meets a key of its own lane.** A plantilla's bare `N5394` finds the
  plan that declares that DGS code; the finect slug keeps routing as the pricing handle
  it is; and a **mistyped** pair (a value that does not validate as its declared kind)
  claims no key at all, so it surfaces as «sin match» — a question the user can answer —
  instead of matching something else in silence.
- **Ranking is untouched.** Every claimant of a key is still indexed and ranked, never
  resolved (#1331/#1366 above): the namespace changes what "the same key" means, not who
  decides which holding it is.
- **Both doors read the keys from that one module**, which is the point of #1366 and the
  acceptance test of this amendment: the same file resolves the same way through the
  importer and through the assistant's matcher (`holding-matcher`, whose own typed lanes
  arrived with #1747). Leaving the matcher on its private index would have meant two
  readings of «the same key» again — the thing the shared module exists to prevent — so it
  now builds its index from the same functions. One consequence is recorded here rather
  than left to be discovered: a holding has **no bare identifier column** any more
  (`MatchPortfolioHolding.isin` is gone; no projection ever filled it), because invariant 2
  of PRD #1741 says one key per state — a holding is found by the pair it DECLARES or by
  its provider symbol, and a value nobody could classify declares nothing.

### The offered backfill: the weak arm this bucket never had

A group whose identifier nobody claims may still be a holding the user already has —
the one whose identifier hole was never filled, which is exactly what the health signal
of #1745 complains about. When a typed group matches such a holding by **exact
normalized name plus a compatible instrument** (`normalizeMatchName`, never fuzzy) and
the hole is EMPTY, the group lands in _matched_ with a visible offer: «este extracto
trae el código N5394; tu ficha no lo declara — al confirmar, se rellena».

Four fences, and each is the reason the offer is safe:

- **It is a proposal.** Including the fund is what accepts it; excluding it leaves the
  ficha exactly as it was. The sentence is printed by the import page and by the
  assistant's proposal card from one function, because a promise about what the confirm
  writes must read the same in both.
- **It never overwrites.** Only an empty hole is filled — a value nobody could classify
  (`kind: null`, the #1416 import exemption) occupies it just as a declared identifier
  does. Filling a hole cannot re-price a holding as another instrument; replacing an
  identifier could hand a later statement the wrong ledger to overwrite (the #1349
  asymmetry, verbatim).
- **It is validated by type.** Nothing is written that the holding's instrument could
  not carry — a plan takes no ISIN, a fund no plan code (#1453).
- **It is atomic with the movements it came with.** The write travels in the import
  command and lands inside its transaction (decision 4): an identity nobody confirmed
  can never outlive a failed import.

When two empty-hole namesakes claim the group, the offer does not resolve the choice: the
row is _pending a choice_ like any other ambiguous identifier, neither surface prints the
offer while it is retained, and the fill follows whichever holding the user names — never
the default the preview happened to render first.

The same generalization applies to the two places that spoke of "the ISIN" as if a file
could only carry one:

- **The per-holding guard** (`statement-identity-guard.ts`, renamed from
  `statement-isin.ts`) compares the file's identifiers to the holding's typed pair
  inside one lane, and its ADR 0018 backfill is now typed too: a plan learns its DGS
  code from its own paper. Its Spanish refusal stopped calling either half «el ISIN».
- **The assistant's all-or-nothing gate** for a transactions document refuses rows with
  no **identifier** (ISIN *or* DGS) rather than rows with no ISIN — before #1748 that
  gate asked a plan for a number it can never have (the other half of #1373).

What a creation writes changes with it: a group that carries a typed identifier the
chosen instrument can hold is born DECLARING it, so two people who import the same plan
share one catalog ficha (the acceptance test of PRD #1741).

### The one thing that no longer matches

An ISIN in a file no longer reaches a holding that carries that ISIN as its **provider
symbol**. That cross-lane hit was the flat space's doing, not a decision: an ISIN is not
a quote route (no provider prices by ISIN — see `identifierAsSymbol`, #1330), so the
holding it would find is one whose pricing handle was mis-filled. When such a holding's
identifier hole is empty and its name matches, the backfill offer above is the honest
path to the same place; when it is not, the fund reads as new and the user decides.

Related: the column this ADR compares (`investment_assets.security_id` +
`security_id_kind`, `'isin' | 'dgs'`) arrived with the v70 migration of #1743; the
classifier and the canonical DGS shape live in `packages/domain/src/security-id.ts`
(#1742).

**Amendment (#1770): «the #1416 import exemption» names where a null kind is BORN,
not who may persist one.** A holding's ficha writes it too — not as an exemption but
as the same fact travelling back: its single field asks by kind, so no box can ever
ask for a value that has none, and a save that did not ask cannot answer «bórralo».
Before this, saving such a ficha dropped the value, which turned the health signal
that sends the user there (`UNCLASSIFIED_SECURITY_ID`, #1745) into the one screen
that destroyed its own evidence. The invariant that did not move: nothing writes a
null kind over a value that IS recognizable — every writer funnels through
`preservedSecurityId`, so the kind is classified at the boundary, never trusted from
the caller.
