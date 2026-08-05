# The assistant's write path is guarded by code, not by the choice of model

The admission gate scores three dimensions and admits only a candidate that clears
the threshold in each. `reading` asks how well a model reads the workspace —
figure and delta attribution, honest missing-fact behaviour, sources cited,
Spanish by default. `tool-discipline` asks whether the turn called the tool it
claimed to call, whether an identifier it wrote came out of a read, whether it
rewrote a debt's history from a series nobody validated, and whether it asks rather
than guesses when the holding or the figure is ambiguous. `attachments` (#1254) asks
the same questions of a turn that carries a DOCUMENT, which is where the product's
money moves: whether the model respects the unvalidated-evidence frontier instead of
reaching for the bulk import, whether the one sanctioned single fact still becomes a
proposal, and whether it asks when the file leaves the holding or the figure
ambiguous. The last two are graded from the tool trace; prose cannot satisfy them.

The dimensions are scored apart because one ratio let the strong one pay for the
broken one. A live run scored the pool's first model at 88% on a day it had faked
a proposal card in prose and written a holding id that came from nowhere: reading
checks outnumber write-path checks about two to one, so the number that decided
admission was mostly measuring the half that was working. A blended score cannot
answer «is this model fit for the path that writes», which is the only question
that matters before a model is allowed near money.

Routing by task — a cheap model for reads, an expensive one for turns that can
end in a write — is deliberately NOT adopted. The one dangerous failure the
write-path questions found is a provenance failure, and provenance is a
server-side invariant rather than a behaviour to hope for: asked to register a
dated repayment, the pool's model called the proposal tool with
`wl_hld_mortgage_id_placeholder_need_to_find_it` and then, in the same turn, with
that string extended into a sentence telling itself the first one was invalid. It
put its own monologue in the identifier field of a write. A frontier model writes
that less often; it does not make the field checkable. Paying per-turn for a lower
frequency, while the boundary itself is still missing, buys the weaker half of the
same guarantee — and the invariant costs nothing per turn, because the server
already knows which reads ran and what they returned. It is no longer missing:
`holding-id-provenance.ts` grounds every id a read answers and refuses a write the
ids nothing grounded (#1263).

This is the same principle as the eighth decision of the PRD #1241 grilling — no
guarantee may depend on the prompt — applied one layer out: a guarantee that
depends on the model is that same bet with a different face. It is also what the
security review of #1246 assumed, where the confirmation card is the last defence
against an injected turn; the card must hold for the model we have, not for the
model we hope to buy.

So both paths keep the same model: the pool's first credential-backed entry,
today Gemini 3.1 Flash Lite, for reads and for writes alike. What the runs fix is
the shape of the bill if that ever changes. One turn's floor is 32.719 characters
— the system prompt plus the name, description and schema of the 35 tools, before
a single word of conversation — which the providers charge as 8.540 input tokens
(Gemini) and 7.031 (Cerebras), measured rather than estimated with
`bun run eval:floor -- --live` on 2026-08-03. (It was 35.390 characters, 9.231 and
7.732 tokens, when this ADR was written; #1342 slimmed it by de-duplicating rules
the prompt and the tool descriptions were both paying for, and confirmed on the way
that tokens track characters roughly one to one.) Routing the write turns to a paid
frontier model therefore trades a free turn for a cents-per-turn one at a volume
worthline meters precisely because it is the product's variable cost (PRD #1160),
and buys a lower failure frequency rather than a boundary. The free tier offers no
second path either: the pool's third entry counted the floor of its day as 14.285
tokens against a 12.000 ceiling and left the pool for it (#1278) — a margin no
slimming was ever going to close, since the ceiling is per minute and one turn
issues up to six requests inside it — and its second lost a question to tokens per
minute even at 55 s of pacing.

The two-model comparison says something a single ratio never could: the two
candidates fail in opposite directions. Gemini acts, and its one dangerous failure
is the identifier above. Cerebras barely acts at all — on two of the five
write-path turns it called no read tool, on the turn that should end in a proposal
it called no proposal tool, and on the turn where the figure is missing it did not
even ask for it. Both clear the threshold in both dimensions. Neither profile is an
argument for buying a better model: one needs an invariant, and the other needs to
do something at all. Three of the five questions grade the model for NOT doing
something, so inertia scores respectably there, and only the tool trace tells
inertia and discipline apart.

What would flip the decision is written down, so it is a deferral and not a
silence. Route by task when a run shows the `tool-discipline` dimension below the
admission threshold, or when it shows a failure of a kind code cannot check: a
proposal that names a real but WRONG holding among ambiguous candidates, or a
figure invented rather than asked for. Both are failures of judgement, not of
provenance, and no server-side invariant can catch them. Until then the write
path's cost stays flat and the work goes into the frontiers.

## Consequences

- Admission is per dimension, so a model that reads well and writes badly is
  rejected rather than averaged into the pool.
- The pool keeps one model for every turn: no per-turn model decision, no second
  cost curve, and no turn whose behaviour depends on which path routed it.
- The fabrication grader calls the production rule itself rather than restating
  it, so widening that frontier cannot leave the measurement behind.
- A committed pool mark from before this dimension existed states a reading score
  and nothing about writes; refreshing it is a real re-run, not an edit.
- The write-path failures the gate finds are ticket material for the frontiers,
  not an argument to change models: the identifier one became the provenance
  invariant (#1263) three hours after the gate reproduced it.
- The eval graders keep measuring the MODEL, not the boundary: a turn that points a
  write at an invented id still scores as one, even though production now refuses
  it before the tool body runs. A gate that only recorded what got through would
  stop being able to tell a disciplined model from a guarded one.
- The case that stayed unmeasured is measured now: a bulk import over evidence
  worthline could not validate needs an ATTACHMENT in the turn, and #1254 gave the
  harness one — a committed CSV, read through the production seam, arriving as
  unvalidated evidence with the frontier armed. Pasted rows never engaged that gate,
  so the tool-discipline question in its place still grades what has no code behind
  it: a debt history rewritten from a series nobody validated.
- Attachment questions are a third dimension rather than more tool-discipline ones,
  for the reason this ADR gives for the second: behaviour over a document does not
  follow from behaviour over a typed question, and one ratio would let either pay for
  the other. Every mark committed before the dimension existed therefore says nothing
  about documents — the same way a reading-only mark says nothing about writes — and a
  re-run is what changes that, not an edit. That is the state today: all three pool
  marks predate it, so the pool runs on evidence that has not been asked this question
  yet. The rule is not weakened for them (the allowlist guard has always checked the
  aggregate, and `admission.ts` scores dimensions per RUN); what is true is that their
  silence about documents is now visible, which is the point of scoring apart.
- The two failures this ADR names as what would flip the routing decision — a
  proposal that names a real but WRONG holding among ambiguous candidates, and a
  figure invented rather than asked for — are now each asked twice: once over a typed
  question and once over a document. If routing by task ever becomes the answer, it
  will be these numbers that say so.

## Amendment (#1373): a document lane takes its rows from the document

`propose_reconcile` was written as a document lane and documented as one — «pasa
holdings y movements TAL CUAL los diste por extraídos» — with nothing checking it.
The rows were whatever the model typed, which is the same shape of bet this ADR
refuses everywhere else, and it cost a real session three turns: handed an
aportación confirmation for «MYINVESTOR INDEXADO SP 500 PP», the model wrote the
name of the OTHER pension plan of the workspace into the row, and filled the
schema's then-mandatory `value` — a field an aportación confirmation does not
contain — with a figure copied from the portfolio snapshot. To the code it was a
clean match: the matcher was given the workspace's own name, so of course it matched.

The boundary, in `reconcile-document-frontier.ts`:

- **The rows come from the extraction.** The tool now receives the documents
  worthline itself validated for the turn's context (the same list the model is shown
  in the DATOS ESTRUCTURADOS block) and the model's `holdings` only SELECT among their
  rows, by name or ISIN. Values, fidelity tiers and movements are the extractor's.
- **A row that points at nothing fails the whole call**, with a message that ROUTES
  (the #1248 rule): the portfolio-wide case belongs in `/patrimonio/importar-extracto`,
  and one dated operation on an existing holding in that holding's ficha until the
  chat lane for it exists (#1374). A batch quietly shrunk to the rows that happened
  to match is how a wrong write looks reasonable.
- **`value` stopped being mandatory** and became a CHECK: demanding a figure the
  document may not contain is what pushed the model to invent one. A relayed value
  that disagrees with the document's by more than a euro rejects the pick.
- **The context, not the turn.** Unlike the exemption of `isValidatedDocument`
  (#1248), which must be this turn's own extraction because a forged `valid` envelope
  could otherwise DISABLE a gate, the rows may come from any validated document the
  model was shown — a user who uploads a cartera and says «cuádrala» in the next
  message is doing nothing wrong. A forged envelope buys nothing here: it would only
  let the user's own browser propose rows the user then has to confirm, which is the
  manual path with extra steps.

The eval keeps grading the MODEL for typing rows it was not given, for the reason
this ADR already gives: a gate that only recorded what got through would stop being
able to tell a disciplined model from a guarded one.

## Amendment (#1374): a missing lane is a boundary failure, not a model failure

The amendment above closed the reconcile's rows. What the same session also showed is
the other half of the story, and it is not about discipline at all: **the model reached
for the reconcile because nothing else took the request.** «Añádeme esta compra», with
an aportación confirmation attached, is the most ordinary thing a manual portfolio can
be asked, and the write inventory had no lane for it — `propose_statement_import` wants
CSV text, `propose_holding` is an alta, `propose_correction` repairs a misconfigured
holding, `propose_reconcile` and `propose_mixed_document_import` are batches. The
attachment extracted cleanly as a `holding_event` with the full identity #1316 gives it,
and no proposer consumed it.

So the model improvised into the only door that would open, and the schema of that door
demanded a figure its document does not contain. Grading the model harder would not have
produced the missing lane. The rule this adds to the ADR:

- **Every write the product supports needs a lane whose schema asks only for what its
  evidence contains.** A mandatory field a real document cannot fill is not a validation
  — it is an instruction to invent. `propose_operation`'s input has no `value` at all,
  and that absence is the fix; the position's worth is nobody's to type.
- **A refusal must name the lane that does take the request.** Every routing message in
  `reconcile-document-frontier.ts` and `operation-terms.ts` names one. When #1374's lane
  did not exist, the reconcile's refusal had to send people to the holding's ficha —
  honest, but a dead end in the conversation; it now names the receipt.
- **The model still decides what no boundary can.** Which of the user's holdings the
  paper belongs to, and whether it is a purchase or a sale. Both are printed on the card
  as separate lines next to the document's verbatim text (#1373's rule), and both are
  fenced where a fence is possible: an id must come out of a read (#1263), an ISIN that
  contradicts the holding's rejects the call, and a document the extraction pinned as an
  ingreso cannot be written as a sale. **Neither is ever defaulted.** `jsonSchema()`'s
  `required` is not validated at runtime, so an absent direction is refused in the tool
  body — the same refusal `parseEarlyRepaymentInput` makes for an absent `mode`. Code
  quietly picking «buy» would be code reading the paper.
- **Where the honest answer is «I can't».** A confirmation with an amount and neither a
  quantity nor a unit price has no encoding on an existing position: the
  «1 participación al importe» form of a value-only alta (#1325) would be revalued to ONE
  share's NAV at the next ripple and swallow the amount. `operation-terms.ts` refuses and
  says which figure is missing, rather than write something that looks right for a day.
