# A proposal is amended by superseding it, and the amendment is a layer

## Context

The "Reconstruir historia" depth (ADR 0056, ADR 0070) puts a card on screen with the
whole observed series — 49 dated balances in the case that motivated this. Each point
has an «Excluir» checkbox and an editable amount, so the user can curate the series
before confirming.

On 2026-08-17, with that card in front of him, a real user did what people do: he
explained the document in the chat.

> Los datos que te aporto son correctos. Reales hasta la cuota de agosto 2026 y
> estimados a partir de allí.

The assistant understood him perfectly and answered «he actualizado la propuesta de
reconstrucción». It had updated nothing; the fabricated-ceremony guard (#1262) said so
underneath, correctly. What he asked for was four clicks away in the card — and the
chat could not reach it (#1423).

The reason was structural, not a prompt failure. `ReconstructionArgs` had no
`proposalId`. `propose_statement_import` had one (it accumulates documents into one
proposal), but the reconstruction did not, so «quita los puntos estimados» was not an
operation: it was **re-emitting the 49 rows minus four**. And that payload is precisely
what this provider pool stops producing — `gemini-3.1-flash-lite` narrates the result
in prose instead of emitting a long structured array (see the sibling failures in #1345
and #1408). The one repair the model could attempt was the one it could not do
reliably, so it hallucinated success.

## Decision

1. **An amendment is a short list of operations over the points that already exist**,
   selected by DATE: exclude / re-include one point or a date range, and correct one
   point's amount. Two fields, not a series. Ranges are inclusive and open-ended
   («a partir de agosto de 2026» is a `from` with no `to`).

   By date and never by index: an amortization schedule repeats a date when that day
   carried two events (ADR 0070), and the engine re-sorts the series, so an index is a
   pointer at the wrong row waiting to happen. A date selects the whole day.

2. **The amendment is a LAYER over the observed series, never a rewrite of it.** The
   persisted `observations` keep saying what the document said — that is their
   provenance — and the amendments (`{date, excluded?, balanceMinor?}`) sit beside
   them. The effective series is derived from both, by one function that the builder,
   the card and the confirm all call. A corrected amount is therefore visibly the
   user's, exactly as it is when they type it into the card.

3. **Amending supersedes: a NEW proposal is prepared from the old one, and the old one
   is discarded.** Both halves are load-bearing.

   New, because a card is the output of a tool call: the amendment has to bring its own
   card carrying the amended series, and the thread then shows what was proposed and
   what was amended.

   Discarded, because the superseded card stays alive in the thread with its own button,
   and its per-point state lives in the client — so confirming it would apply the OLD
   series over the correction the user just asked for. Discarding it makes that button
   answer «la propuesta ya no está disponible» instead of writing. It is also the answer
   to "how many open proposals may there be over one debt": along an amendment chain,
   one. The new proposal is built BEFORE the old one is discarded, so a failed amendment
   leaves the user with the proposal they had.

4. **An amendment that changes nothing is an error, not a silence.** An operation whose
   date or range selects no observed point, and an amendment that would leave no
   applicable balance, are refused with a message. The failure this ADR exists to
   remove is an assistant reporting a change it did not make; a no-op that returns a
   card would be the same lie with a card in front of it.

5. **The routing lives in the two tools' descriptions, not in the system prompt.**
   «Amend instead of re-emitting» is a choice between two sibling tools, which is what
   a tool description owns (#1342). The prompt paid nothing.

## Consequences

- `ReconstructCorrectionPlan` gains `amendments?` and `amendedFrom?`. Old drafts have
  neither and behave exactly as before; the effective series of a plan with no
  amendments is its observed series.
- The confirm applies the effective series when the card sends no edited rows. Rows the
  card DOES send already carry the user's curation, so they win untouched — the card
  remains the last word on its own series.
- The amended card shows the excluded points, folded, with their checkbox pre-checked
  and «Excluido a tu petición» as the reason. Undoing what the assistant did on the
  user's behalf is one click, and nothing the chat removed is hidden.
- `propose_reconstruction_amendment` is classified `accepts` on the unvalidated-evidence
  frontier (#1248), not `rejects` like its sibling: it cannot introduce a single new row
  — it operates on points already persisted — and the most it can carry from an
  unvalidated reading is one corrected amount, which is the single fact the human eye
  validates in the preview. The one-proposal-per-turn cap still applies.
- The turn floor rose (`TURN_FLOOR_CHAR_CEILING`, 38.800 → 40.300). The evidence and the
  arithmetic are in `turn-floor.test.ts`; the trade is a cheap two-field call replacing a
  49-row array that did not work.
- Only the reconstruction depth is amendable today. The same shape would fit any
  proposal whose card curates a list (reconcile's per-row matching is the obvious next
  one), and the decision to generalize is deliberately left to the slice that needs it.
