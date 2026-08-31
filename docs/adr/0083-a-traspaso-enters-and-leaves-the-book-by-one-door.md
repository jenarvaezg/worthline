# ADR 0083 — A traspaso enters and leaves the book by one door

- Status: accepted
- Date: 2026-08-19
- Issue: #1479 (slice 2 of #1393)
- Supersedes / amends: nothing. Completes ADR 0082 (a traspaso is its own pair of
  kinds), whose "no product path writes a traspaso" is what this closes.

## Context

ADR 0082 taught the engine to READ a traspaso: two kinds, a shared `transfer_id`, and
the inherited cost persisted on the incoming row. It deliberately stopped there — the
row constructor validates one row, and the pair's invariants are not visible from
inside one.

What a writer of a traspaso has to guarantee, and none of the existing write paths can:

- **Both halves or neither.** A `transfer_out` with no matching `transfer_in` takes
  capital out of the book — the 17-day hole of #1393, permanently. A lone
  `transfer_in` claims an inherited cost with no origin that ever gave it up.
- **Three figures nobody should type.** The bank states «traspaso 1.018,67 €»; the
  participaciones of each half are that amount over ITS OWN VL, and the acquisition
  cost that travels is a proportion of the origin's basis. Jorge did that arithmetic
  by hand, in a second form, on a different date. That is what «es un tostón» was
  about.
- **The state it reads is a moment, not "now".** The inherited cost is a slice of the
  origin's cost basis *on the transfer date*.

## Decision

**One command mints the pair and one command removes it, and everything a caller
would otherwise compute lives in a pure plan upstream of them.**

1. **`recordInvestmentTransfer`: two rows, one transaction, one ripple.** Both halves
   and the snapshot reconstruction of BOTH holdings commit or roll back together (ADR
   0020). One batched ripple across the two assets, not one per half: the pair shares
   a date, so a ripple each would re-derive the same band of history twice (#1435).

2. **The arithmetic is a pure module, `planTransfer`.** The gate owns a
   transaction; the plan owns the numbers. That split is what makes every hostile case
   a table test rather than a database fixture, and it is what will let the screen of
   #1480 preview exactly the pair it is about to write, from the same code.

3. **The importe rules, and the units are cut where the app can read them.**
   *(Inverted by the #1544 amendment below: a leg may now declare its participaciones
   and derive its VL. The rest of this point still holds for a leg stated as an
   importe.)* Each
   half's participaciones are `importe ÷ its own VL`, rounded to
   `UNITS_READBACK_DECIMALS` — the six decimals `formatUnits` renders (#1395). A raw
   division stores a precision no bank publishes and the ficha cannot print. That
   constant now has ONE home, next to the voice it names; the alta's
   `OPENING_UNITS_DECIMALS` and this gate read the same six.

4. **«Todo» is its own intent, not an amount that happens to be the whole position.**
   It takes the position's units EXACTLY and derives the euro figure from them.
   Dividing at six decimals leaves up to a millionth of a unit behind, and a fund the
   user emptied has to read as empty — a residual position is a phantom holding in
   every list, warning and donut.

5. **An importe over the position is refused, not clamped.** The position fold clamps
   an over-sell with a warning because it is reading a ledger it did not write; a gate
   is the last place that can still say no, and a traspaso the bank never executed
   must not enter the book at all. The refusal carries both unit counts, so the
   message can name them and offer «todo» — which is the ordinary case behind a figure
   that is a cent or two over.

6. **The two halves may state DIFFERENT amounts.** The origin is valued the day the
   capital leaves and the destination the day it lands, days apart, so a real traspaso
   does not balance — 739,22 € out and 740,72 € in, measured in Jorge's book on the
   19-ago retyping pass, with the explicit instruction that no validation should demand
   equal amounts. `destinationAmountMinor` is optional and defaults to what left, so the
   ordinary case still asks for ONE figure; forcing that figure onto both halves would
   have bought 1,50 € of participaciones nobody paid for. What ties the halves is the
   `transferId`, never the money.

7. **An external entry is a first-class HALF, not a broken pair.** «Alta por traspaso
   externo» — a plan brought in from another institution — has no outgoing half to
   write, because the origin belongs to someone else's ledger.
   `recordExternalTransferIn` writes ONE `transfer_in` carrying its own `transferId`, so
   a reader that pairs by that id finds one row and can name it instead of reporting a
   broken pair. The alternatives are both wrong: a `buy` eats a whole year of
   contribution allowance (ADR 0080) for capital that merely moved, and a fabricated
   `transfer_out` promises an origin that does not exist. Its inherited cost is
   DECLARED, since nobody here can derive it, and defaults to the amount that arrived —
   the honest reading of "I do not know what these units cost", booking no latent gain
   rather than inventing one. Jorge did this in enero 2026 and will again.

8. **The currency is read from the book, never declared.** Both halves take the
   holdings' own currency, and two holdings that disagree are refused: the inherited
   cost is an amount in the origin's currency written onto the destination's row, and
   crossing currencies would need a rate nobody stated (#1401).

9. **The user's figures are data; structural impossibilities throw.** A non-positive
   importe, a VL of zero, an importe over the position, two currencies, origin =
   destination → `DomainResult` violations a screen renders beside the field. An
   unknown holding, a non-investment one, a connected one → throw. The database is
   per-workspace (ADR 0030), so the tenant scope IS the query and a holding from
   another workspace is one this book has never heard of — a bug or an attack, not a
   typo worth coaching.

10. **The pair leaves by one door too.** `deleteOperation` REFUSES half a traspaso, and
   `deleteInvestmentTransfer` removes both rows with one ripple. The operations table
   already renders each half as a line with its own «Eliminar», so the row-level
   delete is translated at the action: a click on half a traspaso means «deshaz el
   traspaso». Without the refusal in the store, every future writer would have to
   remember the same rule — the fail-open shape ADR 0082 rejected for the kinds.

## Alternatives considered

- **Two `recordInvestmentOperation` calls at the call site (rejected).** Cannot promise
  both-or-neither, and each caller would re-derive the units and the inherited cost.
  The second call failing is exactly the state the ledger has no way to describe.
- **Compute the inherited cost inside the plan by reading the origin's ledger
  (rejected).** The plan would stop being pure and would need a store. The gate folds
  the origin once and hands in two figures from that ONE fold — taking them from two
  folds could slice a cost that never belonged to those units.
- **Clamp an over-position importe like the fold does (rejected).** It would store an
  amount the user never stated and silently disagree with the bank's confirmation.
- **Let the gate mint the ids (rejected).** A replayed submit would land on a second
  pair. The ids are a function of the submission (#1394), which is the caller's to
  derive — and the store must not read a clock of its own (ADR 0024).
- **Let the row-level delete through and pair up afterwards (rejected).** Same
  fail-open as a `sell` with a flag: it works only while every deleting path
  remembers.
- **Demanding the two halves balance (rejected).** It reads like an invariant and is
  false in the data — see decision 6.
- **Recording an external entry as a `buy`, or as a pair with a fabricated origin
  (rejected).** See decision 7.

## Consequences

- No schema change: v59 already carries both columns.
- `DomainViolation` grows seven traspaso codes, so `mapDomainViolation`'s exhaustive
  switch refuses to compile until each has a Spanish message.
- `planTransfer` is the single spelling of the traspaso arithmetic. #1480's screen and
  #1482's dictated traspaso call it for their previews; neither re-derives units.
- `planStatementMerge` no longer proposes deleting half a traspaso, even one carrying
  `source: "opening"` — which every row the #1485 retyping pass re-typed from an alta
  does, and Jorge's book already holds 42 of them. `replaceOpening` exists to drop the
  SYNTHETIC opening balance an alta minted, never a fact of the ledger; without the
  filter a statement import over such a holding would hit the store's refusal and abort
  the whole load for a row nobody meant to touch.
- A residual position IS reachable through the `amount` branch: an importe equal to the
  whole position leaves up to a millionth of a unit behind, because the exact figure is
  rarely representable in cents. That is inherent to stating a traspaso in euros, and it
  is the reason «todo» exists; the screen of #1480 should steer an amount that covers
  essentially everything towards it.
- A traspaso whose origin later receives a BACKDATED purchase keeps the inherited cost
  it was written with. That is the cost of persisting it on the row (ADR 0082) and it
  is deliberate: re-deriving it at read time is what that ADR rejected. The correction
  is to delete the traspaso and record it again — which is now one action.
- Still not covered: the ledger and drilldown surfaces (#1481), the dictated traspaso
  (#1482), and the retroactive re-typing of pairs already recorded as sell + buy
  (#1485).

## Amendment (#1480, 21-ago-2026) — the screen took the offer

The "Traspasar" screen shipped and it does call `planTransfer` for its preview, as the
consequence above anticipated: `transfer-form.ts` is shared by the island and the
server action, so the participaciones on screen, the refusal shown beside the field and
the rows written are one derivation. Two things the ADR left implicit turned out to
matter enough to write down:

- **The preview folds `operationsUpTo(executedAt)`, not today.** A traspaso is
  routinely recorded weeks late, and a position folded on page load is today's: the
  screen would print figures the gate then refuses (or accept an importe the holding
  never held on the day). The ledger therefore travels to the client, and the fold
  happens per keystroke inside `previewTransfer`.
- **The screen creates the destination holding.** A traspaso to a plan just opened is
  the ordinary case, so `recordTransferAction` writes the holding — inheriting the
  origin's instrument, currency and owners — before calling the gate, and only after
  the figures have passed the same `planTransfer` check the gate will run. A refused
  traspaso must not leave an empty holding behind. This is a second door onto
  `createInvestmentAsset` beside the add wizard, deliberately: routing through the
  wizard is what would lose the half-filled form.

The «steer an amount that covers essentially everything towards «todo»» note above is
NOT implemented: «todo» is offered as its own choice, naming the participaciones the
position holds on the chosen date, but an importe a cent over is still refused with the
message that offers it rather than being silently upgraded.

## Amendment (#1481, 21-ago-2026) — the row says which door

The ledger surface now tells the user what the delete translation above means before
they hit it: a traspaso row's «Eliminar» confirm carries «Se elimina el traspaso
entero: las dos mitades», so the pair leaving by one door is announced at the row, not
discovered after the redirect. The reader-side pairing itself is ADR 0082's amendment.

## Amendment (#1482, 21-ago-2026) — the dictated traspaso goes through the same door

S5 gave the chat a `propose_transfer` lane, and it changes nothing about the door: the
confirm calls `recordInvestmentTransfer`, so a traspaso dictated to the assistant lands
as the same pair, tied by the same `transfer_id`, with the same single date and the same
inherited cost as one submitted from the screen. What the slice had to decide is where
its figures come from, and the answer is not «the model's arguments».

- **worthline parses the importe and the date off the USER's own message**
  (`typed-transfer.ts`), with no model in the loop — the #1418 doctrine, applied one
  door along. The reason is sharper here than for a balance series: the model holds the
  whole conversation, so an `amountMinor` it handed over could be a figure it remembers
  from a portfolio read, and this write moves real capital between two real holdings.
  There is therefore no importe field in the tool's schema at all. What the model still
  decides is the one thing no parser can: WHICH two holdings «el fondo A» and «el fondo
  B» are, grounded as every id is (#1263).
- **Everything ambiguous fails closed, naming the gap.** Two money figures in one
  sentence are refused rather than read by position (they are the real «salió 739,22 €,
  llegaron 740,72 €» case, and the screen has a field for each). «Todo» plus an importe
  is refused as two intents. And **the date is required**: «he traspasado 1.018,67 €»
  with no day in it would be a dated row nobody dated, so «hoy»/«ayer» count as written
  and silence does not.
- **The two VLs are the app's own price, and the card says so.** Nobody dictates a VL,
  let alone two, so each side is valued through the ordinary selection rule (ADR 0006,
  cached beats manual) — the same figure the screen prefills — and the card carries a
  note whenever the price is not the transfer date's own, pointing at «Traspasar» where
  the VL is a field. A holding with no usable price refuses, naming it. This is the
  weakest input in the lane and it is the reason #1544 exists: the honest fix is to let
  a traspaso declare participaciones and derive the VL, as every other operation in the
  book already does.
- **The replay check runs BEFORE the plan**, keyed on the date and the counterpart. A
  ledger that already holds the traspaso is one whose position has already shrunk by
  it, so judging the figures first would answer a repeated dictation with «baja el
  importe» about an importe that was right — the ordering `recordTransferAction`
  already had to learn (#1394).

The asymmetry this leaves standing, deliberately and not silently: a traspaso dictated
to the chat is recorded with no paper, while a dictated COMPRA still answers
`operation_document_required` (#1374's frontier, still open as #1466). The two are not
in conflict — what #1374 fenced out was the MODEL's prose, and this lane brings a
parser instead — but the user-visible rule «lo que me escribes vale» now holds for one
movement and not the other, and closing that is #1466's to do, with this lane as the
worked precedent for how (`typed-transfer.ts` is the sibling `typed-holding-event.ts`
that ticket asks for).

## Amendment (#1541, 21-ago-2026) — the half with no pair got its door

Decision 7 shipped an engine with no caller: `recordExternalTransferIn` had lived in
`packages/db` since S2 with no product path onto it, so the only way to record «traer
un plan de otra entidad» was still one of the two readings that ADR rejects. S6 puts
the door in the **add wizard**, not in the «Traspasar» screen, and that placement is
the decision:

- **It is an alta, not a traspaso.** There is no origin holding in this book to start
  from — the outgoing half belongs to MyInvestor's ledger — so there is no ficha to
  hang it off and nothing to fold. It sits as a third answer to «cuánto tengo», beside
  «sé cuánto tengo hoy» and «tengo el extracto del bróker» (#597), and the three modes
  stay mutually exclusive so a synthetic apertura can never land next to a real entry.
- **The pane previews with the gate's own plan.** `external-transfer-in.ts` runs
  `planExternalTransferIn` for its live «≈ participaciones» and takes every refusal
  about the figures from `mapDomainViolation`, so the pane, the action and the store
  say the same words about the same number — the shape `transfer-form.ts` already had,
  and the drift #1438 measured.
- **The declared cost has no total-vs-unit question.** Unlike the alta's «¿cuánto te
  costó?» (#1490), what the old provider states and what the row stores is ONE total,
  so there is one field and no mode radio. Empty means the importe that arrived, and
  the pane says so naming the figure rather than leaving the default invisible.
- **The declared VL becomes the holding's manual price.** A plan brought over is the
  case with no provider quote at all, and without a price the alta would land in the
  list worth 0 € — the same fill-the-gap `recordTransferAction` already does for a
  destination it creates. It overwrites the saldo pane's price field rather than only
  filling a blank: every pane posts while hidden, so that field may hold a live quote
  or a keystroke left over from before the mode was switched, and the two are
  indistinguishable at the action. A cached price beats a manual one at read time (ADR
  0006), so this only decides what a holding nobody quotes is worth — which for a
  backdated entry is that day's VL, held until someone updates it.
- **The row keeps `source: "manual"`, never `"opening"`.** That mark means «synthetic
  apertura the alta invented» and is what `replaceOpening` may drop; this is a fact the
  user declared, with its own date and its own inherited cost.

The cupo is fixed by a test at the action seam, not by new code: `computeContributionAllowanceUsage`
already counts buys only, and the test records the literal enero-2026 entry and asserts
0 € consumed — beside its twin recording the same figures through «saldo de hoy», which
consumes 95,46 €. The contrast is the regression guard: what spares the ceiling is the
KIND of the row, and nothing else.

On the HUMAN reader side nothing was needed: #1481's `transferRowNote` already prints
«desde otra entidad · coste heredado …» for a `transfer_in` whose `transferId` matches
no counterpart, and the store contract that an unpaired id is ABSENT from the map is
what makes that reading reachable. The MCP reader did need a word: its contract said
the `transferId` was «present on both and on nothing else», which was true only while
this door did not exist. `get_operations` and `AgentViewOperation.transferId` now name
the lone row — «entrada por traspaso externo», not a broken pair and not a purchase —
so an agent reading Jorge's plan cannot report a half-written traspaso.
## Amendment (#1544, 21-ago-2026) — the participaciones are the declared fact, the VL is derived

Decision 3 above — «the importe rules» — is **inverted**, additively. It was the only
door in the book where the participaciones were derived and the price was declared: on a
buy or a sell it is the other way round (`InvestmentOperationPlan.pricePerUnit` is
`(importe − comisión) ÷ participaciones`, «so the cash amount the document states is
reproduced to the cent»), and the printed NAV is kept only as a cross-check.

Why the inversion is the honest model, and not just symmetry: **the position IS
participaciones.** `derivePosition` folds units, «todo» liquidates units, the
reconciliation against the extracto compares units. When the units come out of `importe
÷ VL`, a VL rounded — or typed with fewer decimals than the fund publishes — writes units
that are not the bank's, and that error is permanent: every later valuation, partial sale
and traspaso inherits it. A confirmation, meanwhile, prints the exact participaciones of
each leg. worthline does not record ORDERS (which really are given in euros, the reason
decision 3 read as it did); it records CONFIRMATIONS.

- **`TransferPortion` gains `{ kind: "units", units, amountMinor }`,** and
  `TransferIntent` gains `destinationUnits`. Each leg now states two of its three
  figures and the third is derived: given participaciones and importe, the VL is
  `importe ÷ participaciones` at `PRICE_READBACK_DECIMALS` (#1467); given importe and
  VL, the units are still `importe ÷ VL` cut at `UNITS_READBACK_DECIMALS`. Both prices
  in `TransferIntent` are therefore optional, and a leg that states neither figure is
  refused naming its side.
- **A DECLARED unit count is stored as stated; only a DERIVED one is cut at six
  decimals.** #1395 governs what the app may derive, not what a bank printed.
- **«Todo» may now carry the confirmation's importe,** and then the VL of the whole
  position is derived from it. Its exactness is untouched — the units are still the
  position itself — so decision 4 stands. The visible consequence, stated rather than
  smuggled: on the screen's default reading «todo» now REQUIRES that importe, because
  nothing else can produce a VL there. Nothing is retired (the VL reading still derives
  the amount from the position), but the default path for «todo» asks for one figure
  more, and the refusal says what it is for.
- **Where the two readings cannot agree, the participaciones win** and the VL absorbs
  the difference (`61,601667 part.` for `739,22 €` derives `11,99999994 €`, not `12 €`).
  On coherent figures they produce the same pair, which is a test.
- **The screen offers both readings, participaciones first** (#1480 amended), because
  the ordinary reason to be on that screen is a justificante in hand. The mode decides
  which fields are read — never which happen to be filled, since the hidden pane still
  posts its values.
- **The dictated lane reads «37,203 participaciones» beside the importe** (#1482
  amended). The units token is marked by its own word, so it never competes with the
  euro figure, and it is cut out before the importe is counted. When it is present the
  origin's VL is no longer borrowed from the price cache — so the provenance note of the
  #1482 amendment disappears for that leg, and a holding with no price at all stops
  being a dead end. The DESTINATION's note survives there on purpose: a dictated
  traspaso states ONE unit count, and two in one sentence fail closed
  (`ambiguous_units`) and route to the screen that has a field per leg — so the arriving
  half is still divided at the app's price, and still says so.

What did NOT change: the door, the pair, the shared `transfer_id`, the single date, the
inherited cost as a proportion of the origin's basis, the refusal of units over the
position, and «todo» as its own intent.

## Amendment (#1519, 30-ago-2026) — the door only looks forward, so something has to look back

The atomic gate above guarantees that a NEW traspaso is written whole or not at all. It
says nothing about what is ALREADY written, and two paths bypass it: the one-shots of
`.local/scripts`, and the retroactive re-typing of #1485, which puts a `transfer_id` on
rows that did not carry one. A `transfer_id` with no other half is indistinguishable
from a cost leak in the engine, which is what made the reconciliation of 21-08-2026
spend a whole audit of Jorge's ledger ruling exactly that out.

The audit is a data-health signal (#654), `transfer_integrity`, not a warning on the
ficha: it is not a figure the user typed wrong, it is the book contradicting itself, and
the consumer is whoever maintains the data. Three things it decides:

- **The cost that LEFT is re-derived, never read.** `transfer_cost_minor` does not exist
  on the outgoing leg — deliberately, so the position fold never crosses over to another
  asset's ledger — so the careo folds the origin's own ledger up to the operation before
  the traspaso and takes the same `proportionMinor` slice `planTransfer` took when it
  wrote the pair. Same engine on both sides, so tolerance is **zero** (#1422): a cent is
  corrupt data, not a rounding.
- **Decision 7's reading is binding on the detector too.** A lone `transfer_in`, WITH its
  own `transfer_id`, is the external entry and is never reported. The ficha already names
  that row «desde otra entidad» from the same evidence; a health panel calling it broken
  would make the two screens disagree about one row. A lone `transfer_out` has no such
  reading and IS reported.
- **The units are clamped as the fold clamps them.** The comparison asks what the fold
  removes, so an over-transfer the gate would have refused is careado against the cost
  that is actually there — which is what makes a row carrying the un-clamped proportion
  show up instead of agreeing with a figure the book never held.

## Amendment (#1518, 31-ago-2026) — the external entry keeps its id, and gains a date nobody reads yet

#1518 arrived proposing that an external entry be a `transfer_in` **with no
`transfer_id` at all**, on the reading that an id is a promise of atomicity — «hay dos
filas y su coste se conserva» — that a lone row cannot keep. That reading is
**rejected**, and decision 7 stands unchanged. Three things it did not account for:

- **A `transfer_in` with no id is unwritable-off.** Decision 10 makes `deleteOperation`
  REFUSE half a traspaso outright, and the ficha's row-level delete translates the
  click by asking `readTransferIdOf` first. With no id that lookup returns null, the
  call falls through to the row-at-a-time delete, and the store throws. The row would
  enter the book and never leave it — a worse promise than the one the id makes.
- **Nothing reads the id as a broken pair any more.** `auditTransferPairs` (#1519)
  exempts a lone `transfer_in` explicitly, and `transferCounterpartByOperationId`
  (#1481) resolves an id with no counterpart to `external` — which is precisely how
  the ficha comes to print «desde otra entidad». The id is not a promise the row
  cannot keep; it is the EVIDENCE both readers use to name what the row is.
- **The two shapes are already indistinguishable to every fold.** `derivePosition`
  reads `transferCostMinor ?? 0`, the savings fold zeroes both traspaso kinds, and the
  cupo counts buys only. Dropping the id would change nothing a figure depends on and
  break the two things above.

What #1518 DOES add is the fourth point of its own cure, which had no
implementation anywhere:

- **A declared inherited SENIORITY, `transfer_seniority_at` (v66).** A movilización
  carries the age of the aportaciones that funded it, and those sit in another
  institution's ledger. `executed_at` is the day the capital LANDED: Jorge's two
  entries are dated dic-2025 and ene-2026 for capital aportado years before, so
  reading age off the row says «bloqueado hasta 2035» about money that may be
  rescatable today. The column is DECLARED, never derived, nullable, and backfilled
  with nothing — NULL is «nadie lo ha dicho», which is true of every row written
  before this door. **Nothing reads it yet**; #1528 builds partial pension liquidity
  on top, and it is stored now because the door is the only moment the user has the
  old provider's paperwork in front of them.
- **The seniority is judged in the DOMAIN, not at the form.** `planExternalTransferIn`
  refuses a date that is not a calendar day, and one LATER than `executedAt` — the
  landing day itself is legal, since capital movilizado the same month it was aportado
  is ordinary. The chat writes below the web's guards, so a date the pane would have
  refused has to be refused wherever the intent is built.
- **The inherited cost stays OPTIONAL.** #1518 asked for it to be mandatory. Refused:
  empty already MEANS the importe that arrived, which books no latent gain rather than
  inventing one, and the pane names that figure rather than leaving the default
  invisible. Requiring it would block the alta of anyone without the old provider's
  paperwork — a refusal to record a fact, in exchange for nothing the ledger gains.
- **A second door, on the ficha.** The alta's pane (#1541) records the FIRST
  movilización, as part of creating the holding. The second one — consolidating
  another plan into a PP already on the book — had no path at all: the ficha offered a
  `buy`, which eats a year of cupo (ADR 0080), and «Traspasar», which demands an origin
  that by definition is not here. `recordExternalTransferIn` has accepted a
  `destinationAssetId` since #1479; `ExternalEntrySection` is the missing product path
  onto it, previewing with the same `externalTransferCaptureCopy` the pane runs, so the
  two doors cannot disagree about a figure or word a refusal differently.
- **«External only» is a fact about the writers, not an invariant of the column.** A
  `transfer_in` carries its own `transfer_id` whether or not a counterpart exists — the
  whole point of decision 7 — so the row cannot say which kind it is and nothing could
  enforce the restriction. What is true, and pinned by a test, is that `planTransfer`
  never sets it: an internal pair's origin already has its dates in this book, so only
  the two external doors ask.
- **A declared seniority is VISIBLE.** `transferRowNote` prints «antigüedad desde …»
  beside the inherited cost. No figure reads the date yet, which is precisely why it
  has to be readable: a declared date nobody can see is one nobody can correct, and a
  year typed wrong would sit in the ledger until #1528 quietly built on it — the
  failure mode of #1415, and what ADR 0074 forbids. It is never masked by privacy
  mode: it is a date, not money.
- **The chat still does not learn it.** Out to its own ticket, as #1541 left it.

The data: Jorge's `op_n5459` was already a correct external entry after the #1485
re-typing pass. `op_n5396` (4.979,55 €, 05-12-2025) was still a `buy` and is re-typed
by a one-shot in the same deploy. Neither moves a cent of patrimonio — units and cost
are conserved. What changes is the **ahorro medido de diciembre-2025, which loses
4.979,55 € nobody earned**.
