# An operation is stored in EUR and captured in its own currency

## Context

The valuation converts. The **ledger** did not.

Since #1357 a provider quote in another currency is converted through the ECB rate
before it reaches `asset_price_cache`: Finect publishes **8,6211 USD** for
`Fidelity MSCI Pacific ex-Japan Index Fund P-ACC-USD` and the cache holds **7,4532
EUR**. But every capture path — the operations form, the statement importer, the
assistant's two proposal writers — stamped `currency: "EUR"` onto whatever number it
was handed, without asking.

MyInvestor states that fund's orders in dollars. So a real user's eight purchases
landed like this (#1401, found auditing his portfolio on 2026-08-17):

| Movement in MyInvestor       | Stored in worthline        |
| ---------------------------- | -------------------------- |
| 23-ene-2026: 2,04 US$ / 0,255 part | `0.255 @ 8.00 EUR`   |
| 11-feb-2026: 5,48 US$ / 0,658 part | `0.658 @ 8.3282674772 EUR` |
| 30-abr-2026: 6,22 US$ / 0,759 part | `0.759 @ 8.1949934123 EUR` |

All eight prices are exactly `importe_US$ ÷ participaciones`: dollars wearing a euro
label. A real cost of 28,61 € recorded as 33,68 «€» — **+17,7 %** — which eats the
gain. And it is invisible, because the market value is right: the only figure that
limps is the return, and nobody suspects the return.

`asset_operations.currency` existed in the schema and in
`CreateInvestmentOperationInput`. The **engine never read it**: `derivePosition` folds
every operation into ONE accumulator and labels the result with the *asset's*
currency. The invariant that makes that sound lived in a comment
(`positions.ts:256`, «Every operation of a holding shares its id and currency») and
nothing verified it. Storing an operation in its native currency would not have
raised an error — it would have produced a wrong cost basis in silence.

## Decision

1. **The ledger is EUR, and that is now a stated rule, not an accident.** Every
   operation is persisted in EUR. The cost basis sums one currency, so there is no
   state in which a holding's ledger mixes them.

2. **A non-EUR apunte is _captured_, converted, and remembered.** The capture
   carries its own currency; the write converts it at the ECB rate **dated to the
   execution day** — never today's — and keeps the original price, fees and applied
   rate as the operation's `capture` (four nullable columns, written as a set of four
   or not at all). `executedAt` alone would let us re-fetch the rate, but not pin the
   one actually applied: an ECB revision, or a carry-forward window that resolves
   differently later, must not silently rewrite a cost basis that has already
   rippled through every snapshot. The capture is also what lets the ficha read a row
   back as «8,00 USD», which is how a user reconciles it against the statement.

3. **One door.** `convertCapturedOperations` / `convertStatementRows`
   (`@worthline/pricing`) pair the pure conversion with the ECB fetch it needs, and
   every capture path goes through them: the operations form, the statement importer
   (preview *and* confirm, at the single `readStatementFromForm` door), and the
   assistant's statement proposal. A EUR apunte short-circuits with zero requests, so
   the ordinary path costs exactly what it cost before.

4. **A missing rate refuses the capture.** ECB publishes business days only; the
   snapshot already carries the previous business day forward for
   `FX_CARRY_FORWARD_DAYS` (7) — the same policy the manual repair of those eight
   operations used, and the same one the aggregation applies. Past that window there
   is no honest euro figure, and the write is refused with the date and currency
   named. Never a 1:1 fallback (the #1065 posture, one layer earlier). For a
   statement, one unconvertible row refuses the whole file, like any other malformed
   row (ADR 0010).

5. **The currency is per operation, not per instrument.** A picker next to the price,
   defaulting to the currency this holding's last apunte was captured in
   (`lastCapturedCurrency`, which reads `capture` — `currency` would answer "EUR" for
   the very dollar fund in question). `assets.currency` is EUR for every holding
   today, including that USD fund; changing what it means would drag valuation,
   snapshots and aggregation with it.

6. **A closed capture vocabulary.** `CAPTURE_CURRENCIES` = EUR, USD, GBP, CHF, SEK,
   NOK, DKK, CAD, AUD. All two-decimal, because the money model scales by ×100
   (`fx.ts`): offering JPY would offer a capture whose fee arithmetic is silently
   wrong. Widening it is one line plus a decimals decision — which is the review it
   deserves.

7. **The comment becomes a guard.** `derivePosition` emits a warning when its
   operations are not all in the currency it labels the cost with — including the
   #1401 shape, where the WHOLE ledger is in another currency (checking only for
   disagreement between operations would have stayed silent on the very case that
   cost 17,7 %). A warning, not a failure: the arithmetic is unchanged, so an
   existing portfolio still renders — it just stops being quiet about a figure that
   cannot be trusted. Writes are what prevent the state; this is what admits it when
   an older path already created it.

The conversion itself is one pure function, `convertCapturedFigures`, shared by an
operation about to be persisted and a statement row about to become one — so a
re-imported file can never convert differently than a hand-typed apunte.

## Considered options

- **Convert with today's rate (rejected).** It is what `convertPriceToEur` does for a
  live quote, and it is right there: a quote is a present-time figure. An operation
  is a dated fact, and pricing a 2024 purchase at today's rate is the same class of
  error as the bug, only smaller.
- **Declare a native currency on the instrument and inherit it (rejected).**
  Conceptually cleaner, but `assets.currency` is EUR for everything today and the
  aggregation, the snapshots and the valuation all read it. It also cannot express a
  ledger where the orders are in dollars and a fee row is in euros.
- **Store operations in their native currency and teach the engine to convert
  (rejected).** The honest multi-currency ledger, and a much larger change: every
  consumer of `costBasis`, `realizedPnl`, IRR/TWR and the snapshot ripple would need
  an FX context, and each would need to decide what to do when a rate is missing.
  The figure users need is euros; converting once, at the capture, is where the
  decision is cheapest and most auditable.
- **Refuse (rather than warn) on a mixed-currency ledger (rejected).**
  `derivePosition` returns a summary, not a `DomainResult`, and a hard failure would
  black out a holding's whole ficha over data an older path wrote. The `warnings`
  channel already exists for exactly this grade of problem (the over-sell clamp).
- **Detect the mistake instead of preventing it (rejected as the primary fix, kept
  as an audit).** Comparing a typed price against the instrument's native NAV would
  have caught those eight purchases, but it needs a native currency the schema does
  not store, and it is a heuristic. It survives as a read-only sweep in
  `.local/scripts/audit-operation-currency-2026-08-18.ts`, which asks the provider
  for the native currency and reports the drift per holding.

## Consequences

- Schema v54: `asset_operations` gains `capture_currency`, `capture_price_per_unit`,
  `capture_fees_minor`, `capture_eur_per_unit`. All nullable, nothing backfilled — a
  pre-#1401 row genuinely does not know, and NULL reads as "recorded as euros".
- An **overwrite replaces** the capture, clearing it when the incoming row is euros
  now; otherwise a re-import would leave dollars on screen that no longer back the
  stored figure.
- The plantilla (our own statement format) gains an optional `Divisa` column; an
  unknown currency aborts the load naming the row. The other broker adapters state no
  currency, so their rows stay EUR — the conversion door is in place for the day one
  does.
- The assistant's statement proposal converts when the proposal is BUILT, so the rows
  persisted on it — and therefore the preview card and whatever the confirm writes
  days later — are the same euro figures (#1438). Dating the rate to the execution day
  is what makes the delay harmless.
- Not covered here: the reconcile lane (#1082) still drops non-EUR holdings and
  movements rather than converting them — an honest exclusion that predates this
  door and can now be revisited; and the alta paths (wizard and assistant) still
  capture euros only, which is what their «saldo de hoy» question asks for and what
  `liveUnitPrice` already enforces by rejecting a non-EUR quote.
