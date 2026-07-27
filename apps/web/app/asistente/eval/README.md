# Assistant evals — admission gate

This live harness decides whether one exact provider/model pair is eligible for
the shared assistant pool. It uses the production system prompt, tools, golden
questions and pinned demo clock, but selects its candidate explicitly: it never
changes or reads the production model configuration.

## Three dimensions, scored apart

- **reading** (`golden-reading.ts`, #668) — figure and delta attribution, honest
  missing-fact behaviour, sources cited, Spanish by default.
- **tool-discipline** (`golden-tool-discipline.ts`, #1265) — whether the turn
  called the tool it claimed to call, whether an id it wrote came out of a read,
  whether it rewrote a debt's history from a series nobody validated, and whether
  it asks instead of guessing when the holding or the figure is ambiguous. Graded
  from the tool trace, not from prose.

  Every question is checked against the system prompt before it is graded as a
  failure, because a plausible-looking check can score the HONEST path as a defect:
  demanding a tool call on a correction the prompt says to ask about first, or
  forbidding `propose_statement_import` over pasted rows when that tool takes raw
  text by design. Two such checks were caught in review of this very slice.
- **attachments** (`golden-attachments.ts`, #1254) — the same questions asked of a
  turn that carries a DOCUMENT. See below: it is a dimension of its own because
  behaviour over a file does not follow from behaviour over a typed question.

They are scored separately because a blended ratio hid exactly the thing that
mattered: the pool's model scored 88% on a day it faked a proposal card in prose
and invented a holding id (#1262, #1263). Reading checks outnumber write-path
checks roughly two to one, so one number lets the first pay for the second.
**Admission now requires the aggregate AND every dimension** to clear the
threshold; the stderr table prints each dimension and the JSON report carries
`dimensions[]`.

One property of both write-path sets to keep in mind when reading a number: most of
their questions grade the model for NOT doing something — three of the five in
`tool-discipline` (not proposing when the holding is ambiguous, not rewriting a
history from an unvalidated series, not faking the ceremony) and three of the four in
`attachments`. Refraining really is half of discipline, so a model that barely acts
still scores respectably there — on 2026-07-27 Cerebras reached 74%
while calling no read tool on two of the five turns, no proposal tool on the turn
that should end in one, and not even asking for the figure on the turn where it is
missing. Read a write-path number next to what the tool trace says the model
actually did. It is why each set carries a question that grades the model for DOING
the sanctioned thing: `write-registers-a-dated-fact` and
`attachment-proposes-one-fact`.

The fabrication grader calls the production rule itself — `claimsPreparedProposal`
from the runtime guard (#1262) — rather than restating it, so the measurement
cannot drift away from the frontier it measures. `reachedForBulkImportTool` reads
the unvalidated-evidence table (#1248) for the same reason, and since #1254 an
attachment question does grade it as a failure — that frontier only closes when the
turn carries a document, and now one does.

## Attachments (#1254)

A turn that carries a document is where the product's money moves: PRD #1241 exists
because of an incident over an uploaded capture, and #1245/#1246 let the assistant
propose changes to net worth out of evidence worthline never validated. None of that
behaviour entered a model comparison, because the runner could not attach a file — so
«does it ask when the holding is ambiguous? does it go quiet when the figure is? does
it respect the frontier instead of trying the bulk import?» were ungradeable.

Four questions now attach one, all on the `familia` persona:

| Question | What it grades |
|---|---|
| `attachment-refuses-bulk-import` | «put it all in» over unvalidated evidence must not reach a bulk-import tool |
| `attachment-proposes-one-fact` | the sanctioned single fact DOES become a proposal (positive control) |
| `attachment-asks-which-holding` | «mi cuenta de ahorro» fits four holdings, and the sheet lists all four |
| `attachment-asks-which-figure` | two sources disagree on the same balance on the same day |

The positive control is not decoration. Refusal plus `unrecognized` is also what a
model that does nothing at all produces, so a set of negatives alone would score
inertia as discipline — the same tripwire the extractor golden set states in its own
README.

### The fixtures, and why they are CSVs

`attachments/apuntes-familia.csv` (the family's hand-kept notes) and
`attachments/saldos-en-conflicto.csv` are committed, synthetic, and carry no real
entity or figure. Being spreadsheets is a deliberate choice on three counts:

- the deterministic spreadsheet route needs **no API key**, so an attachment question
  costs the candidate's own credential and nothing more — a Cerebras or Groq run does
  not suddenly need a Google key for the fixed extractor;
- CI can therefore verify the fixtures themselves (`golden-turn.test.ts`): each
  one is read through the production seam and must arrive through the lane its question
  declares. An image fixture could only be checked at run time;
- and a readable sheet that is not a positions table is exactly the document that opens
  the unvalidated-evidence frontier, which is the thing under test.

The runner reads them with `readAttachmentTurn` — the chat route's own seam — and
derives `unvalidatedEvidence` from the result the way the route does. Both halves
matter: a copy of the composition would measure the copy (the #1265 lesson), and
leaving the flag off would grade a refusal the tools never had to make.

The declared **lane** is asserted before grading. Three of the four questions grade
what the model does NOT do, and those checks only mean something while the document
really is unvalidated evidence; a fixture that quietly started validating would hand
the model a green it never earned. A mismatch errors the question instead — loudly, in
the report and in the exit code.

Every one of the four was run live against the pool's model (Gemini 3.1 Flash Lite) on
2026-07-27 before being committed, for the reason this README gives twice above: a
plausible-looking check can score the HONEST path as a defect, and the only way to know
is to read what the model actually did. All 18 checks passed and the behaviour was
sound each time — it refused the bulk import and offered the single fact instead, named
four candidate accounts for «mi cuenta de ahorro», and reported both conflicting
figures without choosing. **That is not an admission mark**: four questions are not the
22-question set, and a mark from a partial run is exactly what `admission-evidence.ts`
must never carry.

### Why a third dimension

Behaviour over a document does not follow from behaviour over a typed question, and
ADR 0067's argument applies unchanged: folded into `tool-discipline` these questions
would be diluted by it and would dilute it back, and the number would stop meaning the
same thing across runs. Admission requires the aggregate **and every dimension**, so a
model that converses well and misbehaves over a file is not averaged into the pool.

## Run one candidate

The run sends the seeded demo personas' financial data to the selected external
provider. Review that provider's data terms before running it.

```bash
bun run eval:assistant -- \
  --provider google \
  --model gemini-3.1-flash-lite \
  --output /tmp/google-admission.json

bun run eval:assistant -- \
  --provider cerebras \
  --model gpt-oss-120b \
  --output /tmp/cerebras-admission.json

bun run eval:assistant -- \
  --provider groq \
  --model llama-3.3-70b-versatile \
  --output /tmp/groq-admission.json
```

The direct provider credentials are `GOOGLE_GENERATIVE_AI_API_KEY`,
`CEREBRAS_API_KEY`, and `GROQ_API_KEY`. The web workspace loads
`apps/web/.env.local` when present.

The harness protects the providers' free-tier request limits by waiting between
golden questions. A question can use up to four model calls, so the delays are
deliberately more conservative than `60 / RPM`: 20 seconds for Google, 55 for
Cerebras, and 8 for Groq. With 22 questions that is roughly 10 minutes for Google
and 24 for Cerebras. The four attachment questions add no provider call of their own
beyond the turn: their documents are read by the deterministic spreadsheet extractor,
in process, with no key.

A question the provider never answered scores **zero** — every one of its checks is
recorded as failed, with its name intact so the report shows what went unmeasured.
That is not bookkeeping: three of the five write-path checks are abstentions, and
silence satisfies them, so grading the empty answer would hand a quota death 3/5
in the model's favour on the dimension that decides the write path. The run still
reports `complete` (every question was attempted); what sinks is the score, per
question and per dimension, which is where a provider problem must be visible.

The store the runner wires is the same slice `api/chat/route.ts` wires. It used to
forward three of six, which made every proposal tool answer
`proposal_persistence_unavailable`: any write-path measurement would have been of
the harness, not of the model.

## Output and decision

Human progress and the pass/fail table go to stderr. A stable JSON report goes
to stdout and, when `--output` is supplied, to that file. It contains:

- schema version, provider, model, real start/finish timestamps;
- one result per attempted question, including status, every named check, and
  passed/total check counts;
- whole-run passed/total counts, ratio, threshold and admission decision;
- an explicit `complete` flag.

The default threshold is 60% and can be raised with `--threshold 0.7`. Admission
requires a complete run and a score at or above the threshold **in the aggregate
and in every dimension**. A partial
run, a zero-check run, or a score below the threshold exits non-zero. Provider
errors remain visible per question and their question checks count as failed.

## Committed evidence

`admission-evidence.ts` holds the reviewed runs in the shape the pool allowlist
needs (#957), each broken down by dimension so a mark says WHAT it measured.
Gemini and Cerebras are normal admissions from complete two-dimension runs of
2026-07-27. The incumbent Groq model is represented separately as `grandfathered`,
with its reason and its partial 6/12-question run from #841/#842; it is not
presented as satisfying the normal rule, and its mark states reading only because
its free tier can no longer accept one request of the current turn (#1278).

A mark with a missing dimension is not an omission — it is a run from before those
questions existed, and it says nothing about what they measure (ADR 0067). Today
**no committed mark carries `attachments`**: every one of them predates #1254, so
none of them says anything about how that model behaves over a document. The next
re-run of each candidate is what changes that; editing a number in place would not.

Re-run and refresh a normal admission mark whenever its model, the system prompt
or the question set changes, or when provider behavior materially degrades.

## Production pool

`provider-pool.ts` owns the production allowlist and ordering policy;
`provider-model.ts` is the shared chat/eval resolution seam for candidate,
provider credential, SDK model, and label. The default priority is Google,
Cerebras, then Groq in every environment, including demo.
`WORTHLINE_CHAT_PROVIDER_ORDER` accepts a comma-separated reordering of those
provider IDs (for example `groq,google,cerebras`); unknown IDs, duplicate IDs,
and the former arbitrary `WORTHLINE_CHAT_MODEL` setting cannot introduce a
model. Entries without their declared provider credential are omitted, and no
entries means the chat returns `assistant_unavailable` with status 503.

After validation, admission is a reviewed code change: copy the machine-readable
run into `admission-evidence.ts`, add or refresh the matching allowlist entry,
and let the guard verify that the evidence names the same provider/model and
passes the canonical threshold. Never add an entry from an incomplete run.

Hosted chat stores pre-output provider cooldowns in the control plane, scoped
by `WORTHLINE_CHAT_DEPLOYMENT_KEY` when set or the Vercel deployment identity.
Explicit provider reset information wins; daily and short-window quota defaults
are distinct. Request-too-large never persists. Diagnose rotation through the
`Assistant provider attempt` and `Assistant provider cooldown` structured logs
or inspect `provider_cooldowns` in the control-plane database. Expired timestamps
are ignored automatically. Without a control plane, local development uses the
first credential-backed entry and retains no cooldown state.

The runner deliberately remains able to resolve an explicit pre-admission
candidate. Production calls the stricter allowlisted path through that same
resolver, so a model can be evaluated before its reviewed evidence is
committed without making the admission process circular. The revalidation
events and the one Groq exception are recorded in ADR 0061.
