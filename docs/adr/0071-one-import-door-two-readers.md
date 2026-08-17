# One import door, two readers

## Context

Jorge, 17-aug-2026, about his Plasencia mortgage: *«me gustaría que el histórico
tuviese los movimientos bien reflejados»*. In one afternoon he tried three ways —
attaching the schedule to the assistant, the statement import, and converting it
with ChatGPT into our plantilla — and none of them was the way, because none
existed (#1406).

What his base held was a plan at a flat 3,3 % with **zero** interest-rate
revisions and **zero** early repayments, plus three balance re-baselines covering
2024 → today. The twenty years before that were fiction: a Euribor mortgage whose
real rate moved between 0,066 % and 5,37 %, modelled as a straight line. His
bank's Excel had all twenty-one revisions and the lumps. Entering them by hand is
twenty-three forms.

The question the implementation had to settle was whether the mortgage's history
could ride the statement import — one model, one format, one preview.

## Decision

**The door is shared; the reader, the model and the preview are not.**

1. **Same entry, `/patrimonio/importar-extracto`**, with a document-type tab
   («Operaciones» / «Cuadro de amortización»), mirrored to the URL as
   `?documento=cuadro`. Both lanes are server-rendered; the tab is a client
   island (interaction-patterns §2/§3). Same vocabulary too — «cargar
   movimientos» covers the debt.

2. **The models do not merge.** A statement row is a **book event**: stored as it
   comes, position derived by summing, merged by date (ADR 0018) — the file *is*
   the truth. A mortgage is a **generative model**: plan + revisions + early
   repayments *generate* the curve (`amortization.ts`). The 271 rows of a cuadro
   are its bank's model's **output**. Loading them as movements would store a
   derived curve as declared truth and lose the cuota, the payoff date, the
   French recomputation at every revision and every what-if — the family of
   shortcuts ADR 0056 already rejected in writing.

3. **The format does not widen either.** Adding `Revisión de tipo` /
   `Amortización anticipada` rows to the plantilla would bless the
   «pass-it-through-ChatGPT-and-upload-the-CSV» path, which has **no verifier** —
   it is literally the path that produced 270 fake operations. It would also make
   the header stop describing itself: `Participaciones`, `Importe` and `Comisión`
   would be empty on half the rows.

4. **The reader writes events, never a plan.** `interest_rate_revisions` and
   `early_repayments` over the plan that already exists; a debt without a plan is
   refused and pointed at its ficha. One transaction, one ripple.

5. **A cuadro verifies its own reading, before saving.** It prints both the
   causes (the rates) and their consequences (the balances), so the curve those
   revisions generate is measured against the balances the same document declares
   — through `debtBalanceAtDate`, the engine that will draw the debt on screen,
   with the tolerance of ADR 0070. That verifier is the best idea in #1406 and it
   does not survive conversion by hand. It also settles an ambiguity no heuristic
   can: rates written as «0,027» with no percent sign are read both ways and the
   reading its own balances reproduce is the one that wins.

6. **A mismatch is confirmable** (ADR 0070 §4), saying what it will do. Only «no
   event left to write» disables the button.

7. **A re-baseline still wins, and none is retired.** ADR 0056's own precedence
   answers the open question: from a re-baseline forward the re-baseline governs
   and the revisions before it are not read there at all. So the reconstruction
   fills exactly the stretch the re-baselines do not cover, and the preview names
   which stretch is whose per checkpoint.

## Consequences

- The pipeline (file → adapter → typed facts → routing → preview → all-or-nothing
  apply → ripple) is genuinely the same **shape** in both lanes, and deliberately
  not the same **code**. Generalizing it today has two real brakes and one
  consumer: ADR 0055 routes by `Identificador` (ISIN / Finect / CoinGecko) and a
  mortgage has none, and the previews are different objects (matched / new /
  ignored / pending-a-choice vs curve-against-declared-balances). **The shared
  seam gets extracted when the third kind of fact appears** (cash/account, which
  #1405 already names), not before.
- The plantilla's «Hipoteca» signpost (#1405) is re-pointed, not removed: it now
  names this tab instead of twenty-three manual forms.
- The tolerance primitives moved into the domain (`balance-tolerance.ts`): the
  assistant's reconstruction and this import ask the same question, so they must
  not be able to drift into two definitions of «cuadra».
- Measured against the real file, the model tracks the bank's schedule to within
  a few hundred euros over twenty years once its lumps are read — and the
  checkpoints are what make a missed lump visible instead of silent.
