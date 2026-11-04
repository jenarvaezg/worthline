# MyInvestor owns its holdings through dated operations that enter by the ingestion port

Status: **accepted** (#1869, #1870, 2026-11-04).

## Context

Numista and Binance are connected sources that mirror a **value**: each sync lists
positions and the holding is `balance × price` (ADR 0016, 0021). Their lifecycles stay
explicit per provider (ADR 0043).

MyInvestor is different in what it gives: dated **orders** (buys, sells, internal and
external transfers, pension contributions), units held today, a cash balance and the
scheduled contributions. Two things in worthline depend on the operations, not on a
value:

- the cost, which is a **moving average** computed by worthline (never MyInvestor's
  «invertido», which after a transfer is the transferred value, not the inherited
  cost);
- the transfer pair `transfer_out` / `transfer_in`, with the cost travelling from the
  origin (ADR 0082).

The ingestion port of ADR 0066 is exactly this shape (normalize → reconcile → apply
atomically with batch provenance, a cursor and a dedup ledger), and it has no consumer
in the web yet.

## Decision

1. **Hybrid path.**
   - **The connection is explicit per provider** (ADR 0043): a `connected_sources` row
     with adapter `myinvestor`, its own connect / sync / disconnect module, and
     holdings routed by their source (ADR 0102).
   - **The operations enter through the ingestion port** (ADR 0066): the adapter
     normalizes finished orders into facts with a stable dedup key, the application
     reconciles them against the ledger and applies them with `ApplyDatedFactsBatch`
     (one batch, one transaction, one ripple). The cursor keeps a 30-day overlap
     (ADR 0114, decision 5). The adapter passes `describeConnectorConformance`.
2. **The source owns the quantities; worthline owns the price.** A linked holding is
   read-only. Its units come from the operations, its value is units × the price
   worthline fetches by ISIN or DGS code. MyInvestor never sets a price. A managed
   portfolio's declared value is only a witness (ADR 0085, #1550).
3. **Each sync ends with the exact-units check.** The ledger's units of each linked
   holding must equal what MyInvestor reports today. A mismatch applies the
   operations anyway, raises a health signal with the difference and offers «resync
   all». No adjustment is ever created automatically.
4. **Transfers.**
   - The adapter sets the `transferId` of both legs of an internal transfer.
   - Internal pension-plan transfers carry no common id (#1872), so it is derived
     from a synthetic key: account, date, amount, opposite types and different DGS
     codes.
   - For internal fund transfers, whether MyInvestor gives a shared reference is not
     verified yet. If it does not, the same synthetic key applies, using the ISIN
     instead of the DGS code.
   - An external transfer that comes in asks the user for the inherited cost. It is
     the only write the user makes on a linked holding.
5. **Amends ADR 0041.** A linked holding has no worthline contribution plan: the
   past is data and the future is already declared in MyInvestor. On linking, its
   plan lines close with today's date and their pending occurrences are deleted. The
   scheduled contributions read from MyInvestor feed only the «contribution has not
   arrived» signal and the pension ceiling forecast (ADR 0080). The worthline plan
   stays for what is not connected.
6. **Disconnecting freezes** each linked holding as manual, with MyInvestor's
   operations. The manual operations it replaced on linking are not restored; they
   remain in the linking batch's provenance (ADR 0062).

### How decisions 5 and 6 landed (#1881)

- **Linking is part of the include batch.** A product whose ISIN or DGS code a live
  manual investment already carries is offered to link (a holding alike only by name
  is a suggestion, never ticked). Confirming moves the holding's manual operations out
  of the book and writes MyInvestor's, in the same `fact_batch`, transaction and
  ripple as the holdings the include creates. The ripple's floor is the earliest of the
  replaced and the incoming dates.
- **A traspaso is replaced whole or not at all.** A manual holding with half a
  traspaso links only together with the holding of its other half, in the same batch.
  Otherwise the half left behind would read as a flow nobody made (#1393).
- **The replaced operations are the batch's provenance.** They are kept, whole, in
  `fact_batch_replaced_operations` under the linking batch's id (schema v76). Nothing
  folds them. Their only parent is the holding, so they outlive a disconnect and travel
  in the workspace document, which carries no batches. This is the one place where a
  batch keeps more than its header (ADR 0062 amended).
- **"Pending occurrences are deleted" means they leave the pending list.**
  Occurrences are derived, never stored, so there is no row to delete. Each running
  line ends today, a line that has not started yet is removed, and every occurrence up
  to today still pending is settled as `skipped`, the one closed state that keeps no
  execution truth. The careo previews this with the same function the command applies
  (`closeContributionPlanOnLink`).

## Considered options

- **A live mirror like Binance.** Rejected: it loses the operations, so the cost,
  the transfer pairs and the return all break.
- **Dated facts with no ownership, through the reconciliation inbox only** (the
  charter's first recommendation). Rejected in #1869: every sync would ask the user
  to confirm what the bank already knows, and a hand edit could drift from the
  source.
- **Everything through a generic connected-source lifecycle.** Rejected by ADR 0043:
  the three sources diverge more than they share.

## Consequences

- MyInvestor is the first real consumer of the ADR 0066 port in the web. Whatever the
  port lacks for a live source (a cursor with overlap, the units check after apply)
  is added to the port, not worked around in the adapter.
- `SourceAdapter` gains `myinvestor`. Every branch on the adapter tag
  (`instrumentForAdapter`, `frozenInstrumentForAdapter`, the daily capture) has to
  answer for it.

## Amendment (#1882, 2026-11-04) — an internal fund transfer is resolved by a confirmed proposal

Decision 4 left internal fund transfers open: the captured `INTERNAL_TRANSFER_*` pair
shares no id, no day and no amount, so the adapter never pairs it. The design review chose
**proposal + confirmation** (#1882, PRD #1876 open decision 1):

1. **The unpaired legs are written as what they read as.** The outgoing
   `INTERNAL_TRANSFER_REIMBURSEMENT` is a `sell` — capital left with no known
   destination — and the incoming `INTERNAL_TRANSFER_SUBSCRIPTION` is a `transfer_in`
   with its own `transferId` and a provisional cost (the value that arrived). A lone
   `transfer_out` is not written: it would take capital out of the book with neither
   a destination nor a gain, and the traspaso audit reads it as broken.
2. **The mark is durable, on the row.** `asset_operations.transfer_leg_state` (v77):
   `cost_pending` on an entry whose cost nobody gave, `cost_declared` once the user
   typed it, `cost_from_origin` once it came from a confirmed origin, `unpaired_out`
   on the reimbursement written as a sale. It survives every sync: the answer
   updates the rows the connector wrote, whose ids are the orders' dedup keys, so
   re-reading the same orders never rewrites it.
3. **A rule by proximity PROPOSES the origin; it never pairs on its own.** For a
   pending entry that is not from another institution, the candidate is an
   `unpaired_out` reimbursement of another holding of the same source, in the same
   currency, that left in the **10 days** up to the entry (its own day included), for
   an amount within **±5 %** of what arrived. Of several, the nearest amount wins,
   then the nearest day. The user sees it in the ficha's «Coste del traspaso» panel
   and answers «Sí, vienen de ahí» or «No, vienen de otro sitio» (which opens the
   field). An entry from another institution is never offered an origin.
4. **Confirming turns both legs into ONE traspaso** (ADR 0082): the reimbursement
   becomes the `transfer_out`, it stops realizing a gain, both share the entry's
   `transferId`, and the entry inherits exactly what the origin's fold removes —
   `costLeavingOrigin`, the same function the traspaso audit careos every pair
   with. One fact batch, one transaction, one ripple of both holdings (ADR 0062).
   Without confirmation the reimbursement stays a sale and the entry stays pending.
5. **While a cost is pending, nothing measured against it is a figure.** The
   holding's «Ganancia total» and TIR read «—» with «sin coste real: falta el de un
   traspaso» (#1505's grammar) on the ficha, and the board row shows none — the
   same `holdingReturns` returns no view for either; the ledger says
   «coste heredado: falta»; a blocking warning, `TRANSFER_COST_PENDING`, names the day
   and is also a data-health signal. The provisional cost is in the fold and never
   shown as one.

What it does not settle:

- The window and the tolerance were read off the captured pair (five days apart);
  the fixtures' amounts are invented, so ±5 % still has to be contrasted with the
  real account. They are constants (`TRANSFER_ORIGIN_WINDOW_DAYS`,
  `TRANSFER_ORIGIN_TOLERANCE_BPS`), not configuration.
- A reimbursement on a product that was never included has no row to convert, so it
  is not proposed; the entry is answered by typing the cost.
- Until it is confirmed, the reimbursement is read as a sale everywhere a sale is
  read: it realizes a gain, and the measured savings (ADR 0075) count it as money
  taken out of the portfolio that month while the entry, a `transfer_in`, counts as
  none. A real internal traspaso the user leaves unconfirmed — or answers «no, they
  came from elsewhere» — keeps that reading for good. It is the design's choice
  (#1882) and the price of never pairing on a guess; a softer reading for an
  unconfirmed `unpaired_out` is open, not decided here.
- Under ADR 0082 decision 4 the holding's own gain and IRR read a traspaso as a flow
  at the day's value, so the answered cost does not change those two figures; it
  changes the cost basis — the plusvalía latente, the realized P/L of later sales,
  and the snapshots' cost. Hiding them while pending is the design's choice (#1882,
  variant A), not an arithmetic dependency.

## Amendment (#1876, 2026-11-04) — the strong twin, and what the scheduled contributions feed

Two points where what landed differs from what this record and its tickets said:

1. **A strong twin is recognized by its ISIN or its DGS code alone** (#1881).
   #1881 asked for securities account + ISIN for funds and ETFs. A manual holding
   keeps no securities account, so there is nothing to compare the account with:
   `findMyInvestorTwins` offers to link a live manual investment that carries the
   product's ISIN or DGS code, whatever account the product sits in. When several
   manual holdings carry the same code (legitimate, #1399), all of them are offered,
   and the careo goes holding by holding. A holding alike only by name is still a
   suggestion, never ticked. A managed portfolio's funds are careed with their
   portfolio, as a block (#1883), never on their own.
2. **The scheduled contributions also feed the monthly split on /objetivos** (#1886).
   Decision 5 said they feed only the «contribution has not arrived» signal and the
   pension ceiling forecast. They also appear in the monthly contribution split, read
   only and marked «de MyInvestor», because a linked holding has no worthline plan
   and the split would otherwise leave out money that does go in every month. The
   ceiling forecast and the split add up the same expanded entries
   (`myInvestorScheduledEntries`). Nothing is counted twice: linking closes the
   holding's worthline lines, the plan's gate refuses a new one towards a linked
   holding, and the ceiling forecast drops any line still pointing at one.
3. **MyInvestor's cash account has a weak twin, never a strong one.** worthline keeps
   no IBAN or account number for a cash account, so there is nothing to compare
   MyInvestor's with. Including it next to a cash account the user already keeps by
   hand for MyInvestor would count that money twice, so `findMyInvestorTwins` offers
   as a suggestion (reason `cash`) a live manual cash account outside any managed
   portfolio whose name says «MyInvestor» or is alike to the product's. Like the twin
   by name of #1881 it opens at «No incluir». Linking it is a cash link (the same
   `cashLinks` a portfolio's sibling takes, #1883): the account becomes the source's
   and takes MyInvestor's balance; no operation moves, because a cash account in
   worthline is a stored balance, and from then on the sync writes that balance
   (S5's model for cash, S9's `cashBalances`). The fold shows the balance before and
   after instead of a careo, and «Así queda tu patrimonio» adds the difference. A
   robo-advisor's cash is still its portfolio's sibling and links with the block.
4. **A loose manual fund with the ISIN of a robo-advisor's fund is flagged, not
   linked.** Point 1 keeps a portfolio's funds out of the one-by-one twins, so a
   manual holding outside any portfolio that carries the ISIN of a fund of the block
   would be counted twice if the block were included. The block now lists it
   (`looseTwins`), opens unticked and says which holding doubles which fund and what
   to do: send it to the Papelera or put it in a portfolio (then it is offered as
   the block's twin). Offering it as a member to link was left out: a portfolio
   link is all or nothing (#1883), and a loose holding is not part of any.
