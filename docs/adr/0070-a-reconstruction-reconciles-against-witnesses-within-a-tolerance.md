# A reconstruction reconciles against witnesses, within a tolerance

## Context

The "Reconstruir historia" depth (ADR 0056, PRD #1048 S5) turns a dated balance
series read off a bank document into a chain of **balance re-baselines**. Its
guarantee was a single line:

```ts
matches: resultingMinor === ctx.currentBalanceMinor
```

The endpoint of the reconstructed curve had to equal, **to the cent**, the
liability's stored `current_balance_minor`. That check gated the card's
«Confirmar» button _and_ the server's confirm, so it was a door standing twice.

The first real document to meet it broke it (#1422, 2026-08-17). A mortgage
schedule with 49 observed balances reconstructed to 51.881 €. The check compared
it to 52.375,33 € — a figure the user had typed by hand in July — and refused.
His answer was the only one available to him: «los datos que te aporto son
correctos». He was right. The app's own curve for that debt said 51.886,90 €:
**the document and the live curve agreed within 6 €, and the outlier was the
anchor**. Worse, `current_balance_minor` is a field `debtBalanceAtDate` does not
even read once a debt has a plan or a re-baseline (`storedBalanceGovernsDebtFigure`,
#1290) — the judge was a field the engine ignores.

Two failure modes, not one:

- **The tolerance.** A curve derived from ~49 observed points can never be
  expected to reproduce a stored figure to the cent. One cent of rounding closed
  the door exactly as hard as 494 € of stale anchor.
- **The judge.** When a document and an anchor disagree, three things can be
  wrong — the document, the anchor, or the debt model — and the code always
  assumed the first.

The escape hatch made it worse: editing any point set `dirty` and lit the
button, but the server re-ran the same equality and answered «la serie **ya no**
reconcilia», blaming the user for breaking something that never reconciled.

## Decision

1. **A tolerance, not equality.** `max(1 €, 0,1 % del saldo)`. It absorbs cent
   rounding and the ordinary drift between two amortization schedules; a stale
   anchor's ≈1 % stays audible.
2. **Two witnesses, and matching one is enough.** The endpoint is measured
   against the **declared balance** and against **what the app's own curve says
   today**, and reconciles if it agrees with the closer one. Neither is truth on
   its own: the declared field is hand-typed and never verified, the model curve
   is the very thing a reconstruction exists to correct.
3. **The anchor is audited, not obeyed.** When the debt's own curve does not
   reproduce the declared balance, the card says so with all three figures. It is
   a diagnosis that depends on no document, and in the measured case it named the
   right culprit before any document was read.
4. **A mismatch is confirmable, saying what it will do.** Reconciling is a
   verdict the card renders, not a lock. Confirmar asks only that a point remain
   to apply.
5. **Confirming re-derives the declared balance** from the accepted curve, in the
   same transaction as the re-baselines that justify it. «El documento tiene
   razón, actualiza el saldo declarado» was literally what the user asked for in
   the chat, and it had no button anywhere.
6. **Two balances on the same date: the last row of the document wins.** A
   schedule repeats a date when something happened twice that day (two early
   repayments); the balance that closes the day is the last one, never the first.

7. **Both witnesses come out of the same engine.** The projected endpoint and the
   live curve are compared, so they must be computed with the same inputs — early
   repayments and valuation cadence included. The import context used to drop
   both, which was harmless while nothing compared the two curves and is not
   harmless now that one of them gets written back as the declared balance.

The tolerance, the witnesses and the sentences live in ONE pure module,
`apps/web/app/asistente/balance-reconciliation.ts`, because the gate existed in
two places and any fix applied to only one reproduces the trap. There were in
fact **four**: the reconstruct card and its confirm, the `balance_history_import`
card and its confirm, and the mixed-document confirm — where one debt's mismatch
aborted the whole batch, taking the document's funds and property valuations with
it. All of them now state the verdict and let the user decide.

## Considered options

- **Tolerance only, anchor still the judge (rejected).** It does not open the
  measured case: 494 € is 1 % of the balance, far outside any honest margin. It
  would have shipped a fix that changes nothing for the user who reported it.
- **Reconcile against the model curve only (rejected).** Throws away a perfect
  corroboration when the document and the declared anchor agree exactly — and
  the model curve is precisely the figure under suspicion when a user brings a
  document to correct it.
- **Keep the block and add a separate "update my declared balance" button
  (rejected).** Two steps for one intent, and the user would have to understand
  the anchor/curve distinction to know which button to press first.
- **Let the model decide whether to apply (rejected).** ADR 0067: the write path
  is guarded by code, not by model choice. The verdict is computed; the decision
  is the user's, taken on a card that states the consequence.

## Consequences

- `BalanceReconciliation` replaces the `{expectedMinor, resultingMinor, matches}`
  triple in both the balance-history and the correction (reconstruct) contracts.
  `matches` survives as `status !== "mismatch"` and is no longer a gate.
- The confirm can now write `current_balance_minor`, so the reconstruct branch of
  `applyAssistantCorrectionProposal` takes an optional `redeclaredBalanceMinor`
  and the command host gains `updateLiabilityBalance` as a seam. The persisted
  correction fact keeps the **declared** before-value for undo/audit. The write
  goes **before** the import, so the ripple the import fires values the dates
  before the first re-baseline with the new anchor rather than freezing the old
  one into the snapshots.
- That write is only ever reached for a debt whose curve governs its figure:
  `projectBalanceHistoryProposal` now enforces the `amortizable` model its own
  error message always claimed. Where the stored field IS the live figure
  (revolving/informal) it would need a ripple, and the honest answer is to refuse
  the whole projection rather than to move a number quietly.
- A stale browser tab from before this change loses the reconstruct card (the
  draft survives and the next turn rebuilds it) rather than rendering half a
  guarantee — the `parseCorrectionProposal` convention (#1373).
- Points folded as duplicates now say which one won, and the accepted point for a
  repeated date changes from the first to the last.
- Not covered here: which rows of a schedule are observations vs forecast
  (#1424), and amending a proposal without re-emitting all 49 rows (#1423).
