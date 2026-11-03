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
