# Assistant evals — admission gate

This live harness decides whether one exact provider/model pair is eligible for
the shared assistant pool. It uses the production system prompt, tools, golden
questions and pinned demo clock, but selects its candidate explicitly: it never
changes or reads the production model configuration.

## Two dimensions, scored apart

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

They are scored separately because a blended ratio hid exactly the thing that
mattered: the pool's model scored 88% on a day it faked a proposal card in prose
and invented a holding id (#1262, #1263). Reading checks outnumber write-path
checks roughly two to one, so one number lets the first pay for the second.
**Admission now requires the aggregate AND every dimension** to clear the
threshold; the stderr table prints each dimension and the JSON report carries
`dimensions[]`.

One property of the write-path set to keep in mind when reading a number: three of
its five questions grade the model for NOT doing something (not proposing when the
holding is ambiguous, not rewriting a history from an unvalidated series, not
faking the ceremony). Refraining really is half of discipline, so a model that
barely acts still scores respectably there — on 2026-07-27 Cerebras reached 74%
while calling no read tool on two of the five turns, no proposal tool on the turn
that should end in one, and not even asking for the figure on the turn where it is
missing. Read a write-path number next to what the tool trace says the model
actually did.

The fabrication grader calls the production rule itself — `claimsPreparedProposal`
from the runtime guard (#1262) — rather than restating it, so the measurement
cannot drift away from the frontier it measures. `reachedForBulkImportTool` reads
the unvalidated-evidence table (#1248) for the same reason, but no question grades
it as a failure: that frontier only closes when the turn carries a document, and
the harness cannot attach one yet (#1254).

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
Cerebras, and 8 for Groq. With 18 questions that is roughly 8 minutes for Google
and 20 for Cerebras.

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

A mark with only `reading` is not an omission — it is a run from before the
write-path questions existed, and it therefore says nothing about whether that
model can be trusted to prepare a write (ADR 0067).

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
