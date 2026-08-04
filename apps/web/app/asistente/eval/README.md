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
  costs the candidate's own credential and nothing more — a Cerebras run does not
  suddenly need a Google key for the fixed extractor;
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
```

The direct provider credentials are `GOOGLE_GENERATIVE_AI_API_KEY` and
`CEREBRAS_API_KEY`. The web workspace loads `apps/web/.env.local` when present.

The harness protects the providers' free-tier request limits by waiting between
golden questions. A question can use up to four model calls, so the delays are
deliberately more conservative than `60 / RPM`: 20 seconds for Google and 55 for
Cerebras. With 22 questions that is roughly 10 minutes for Google and 24 for
Cerebras. The four attachment questions add no provider call of their own
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

## What a turn costs before it starts (#1278)

`floor.ts` is a second, much cheaper meter, and it answers a different question:
not how well a candidate answers, but whether it can accept the request at all.

```bash
bun run eval:floor            # deterministic, offline, no credential
bun run eval:floor -- --live  # + one minimal request per credential-backed entry
```

The offline half prints the floor of a bare turn — the system prompt plus the
name, description and JSON schema of every tool, before a word of conversation —
in characters, attributed per tool and ranked, which is where slimming has to
aim. Characters and not tokens on purpose: each provider tokenizes with its own
BPE, so a token count computed here would be a fourth tokenizer's opinion. On
2026-07-30 that floor was **35.390 characters**, 26.359 of them the 34 tools'
descriptions and schemas and 9.031 the system prompt, and `turn-floor.test.ts`
holds it under a reviewed ceiling so it cannot drift up unnoticed.

`--live` sends one real request with a one-token answer cap and reads
`usage.inputTokens`, which is the only honest source of a token figure. That
floor measured 9.231 tokens for Gemini, 7.732 for Cerebras, and was rejected
outright by Groq with «Limit 12000, Requested 14285» — the measurement behind
#1278.

### What #1342 cut, and what is left

The floor is now **32.719 characters** (35 tools; 25.281 tools + 7.438 prompt) —
8.540 input tokens for Gemini and 7.031 for Cerebras, measured live on 2026-08-03.

Nothing was cut that was a rule. What was cut was the same rule written twice: the
prompt and the tool descriptions are BOTH re-sent on every step of every turn, so a
sentence in both places is paid twice and a sentence per tool is paid once per tool.
The seam now is that **when to reach for a tool** belongs to the prompt (one copy)
and **how to fill that tool's arguments** belongs to its description. Concretely:

| Rule | Was | Is |
|---|---|---|
| the eleven `propose_*` tools, glossed one by one | prompt + each tool's own description | each tool's description |
| a write to a sync-owned holding is rejected | prompt + 5 descriptions | prompt + `connected-source-write-guard.ts` |
| an id must have come out of a read | prompt + 7 descriptions | prompt + `holding-id-provenance.ts` |
| the alert's three categories | prompt + `raise_maintainer_alert` | `raise_maintainer_alert` |
| `suggest_actions`' own parameters | prompt + `suggest_actions` | `suggest_actions` |
| register the dated fact, don't re-baseline | prompt + `propose_early_repayment` | prompt |
| resolve the symbol before a market alta | prompt + 2 descriptions | prompt |
| a split is not supported | prompt + 2 descriptions | prompt |

Two prose tripwires in `turn-floor.test.ts` guard the two rows with a code boundary
behind them, because that regrowth is measured: the floor gained 1.634 characters in
the four days between #1278 and #1342, one write tool at a time, each carrying its
siblings' boilerplate. They match on wording, so they catch the regrowth of those two
sentences and not every possible duplication — the six rows that moved on prose alone
are held by the harness runs, not by a test.

**Tokens track characters at roughly one to one, and that is now measured.** Between
the two floors both measured live — 35.390 and 32.719 characters, −7,55% — Gemini
charged −7,49% and Cerebras −9,07%. It vindicates the meter's choice of unit
(`turn-floor.ts` assumes characters are a faithful proxy for a bill nobody can
tokenize three ways) and it means a character saved is a token saved. Do not compare
against the 37.024-character floor this slice started from: no live figure was ever
taken for it.

Where the remaining 32.719 sit, for whoever slims next: **14.462** in tool
descriptions, **10.127** in their JSON Schemas, 7.438 in the prompt. Descriptions are
still the majority, but what is left in them is per-tool argument semantics rather
than duplication, and the schemas are the contract itself — not sentences anyone can
rewrite. Cutting materially further probably means offering fewer tools per turn
(35 tools at ~722 characters each), which is a behaviour change and its own ticket,
not more editing.

### What has been added since (the floor is not frozen)

The bare floor measured **33.982** characters on 2026-08-04 (7.663 prompt + 26.319
tools), and the widest one — the onboarding turn, which is what the CI ceiling is
set against — **35.923**. That leaves 2,9% of headroom under
`TURN_FLOOR_CHAR_CEILING`, not the ~7% its comment was written with: the next slice
that adds a tool family trips it, and raising it is a decision that belongs in the
PR that raises it.

#1346 spent 895 of the difference from #1342's 32.719 on the row identity of an
import, and #1347 the remaining 368: a boundary always costs prose in two places,
the description that tells the model the rule and the prompt line the code cannot
enforce. #1347 paid for part of its own share — the alert bullet dropped wording
its tool description carries, and the concision bullet dropped a «cita las cifras»
that duplicated the traceability rule — so its net prompt cost is 225 characters.

| Rule | Was | Is |
|---|---|---|
| an alert needs a real discrepancy | nothing (a hope) | `raise_maintainer_alert` + `maintainer-alert-evidence.ts` |
| never promise a review by «el equipo» | nothing (a hope) | prompt |

## Committed evidence

`admission-evidence.ts` holds the reviewed runs in the shape the pool allowlist
needs (#957), each broken down by dimension so a mark says WHAT it measured.
Gemini and Cerebras are normal admissions and they are the whole pool: the third
entry, Groq, was retired in #1278 because its free tier can no longer accept one
request of the current turn (12.000 tokens per minute against 14.285 measured),
which also retired the one `grandfathered` mark the pool used to carry.

- **Gemini — 2026-08-03, 62/83, all three dimensions.** Re-run by #1342 (the prompt
  and the tool contract both changed) and the first mark that says anything about
  `attachments`: 28/42 reading, 18/23 tool-discipline, 16/18 attachments.
- **Cerebras — 2026-07-27, 49/65, two dimensions. Revalidation pending.** #1342
  changed its contract too, so this mark is stale and knowingly carried. Two attempts
  that day failed to complete — the first died at question 20 of 22, the second lost
  four of its first six to «Tokens per minute limit exceeded» at 55 s of pacing once
  the day's earlier runs had spent the free-tier allowance. **Re-run it on a fresh
  allowance.** An incomplete run may never become a mark.

A mark with a missing dimension is not an omission — it is a run from before those
questions existed, and it says nothing about what they measure (ADR 0067). That is
what Cerebras's missing `attachments` means: for that entry the pool admits on
evidence that says nothing about how the model behaves over a document. Only a
re-run changes it; editing a number in place would not.

Re-run and refresh a normal admission mark whenever its model, the system prompt
or the question set changes, or when provider behavior materially degrades.

### Reading a score change (#1342)

A slice that touches the prompt or the tools should take a baseline the SAME day,
against pre-slice `main`, before reading its own number as a regression. Three Gemini
runs on 2026-08-03 measured the variance: `main` 61/83, an earlier build of the slice
57/83, the shipped build 62/83 — ±5 checks on single samples, with `main` in the
middle. Compare check by check, not totals: the swing sat almost entirely in
`responde en español`, a marker-count grader on prose that flipped in both directions
between runs, and every rule-shaped failure that existed failed on `main` too. The
`--output` reports make that diff mechanical, and it is the only way to tell a lost
rule from a coin toss at this sample size.

## Production pool

`provider-pool.ts` owns the production allowlist and ordering policy;
`provider-model.ts` is the shared chat/eval resolution seam for candidate,
provider credential, SDK model, and label. The default priority is Google then
Cerebras in every environment, including demo.
`WORTHLINE_CHAT_PROVIDER_ORDER` accepts a comma-separated reordering of those
provider IDs (for example `cerebras,google`); unknown IDs, duplicate IDs,
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
events are recorded in ADR 0061, together with the measured reason the pool is
two entries deep.
