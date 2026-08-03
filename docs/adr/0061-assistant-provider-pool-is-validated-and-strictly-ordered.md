# The assistant provider pool is validated and strictly ordered

The shared financial assistant resolves models from one committed allowlist. Its
default priority is strict: Google Gemini 3.1 Flash Lite, then Cerebras GPT OSS
120B. The first entry whose own provider credential is present is selected.
Local, preview, production, and demo use this same default;
`WORTHLINE_CHAT_PROVIDER_ORDER` may only reorder providers already in the
allowlist. Missing credentials remove entries rather than producing a provider
error, and an empty pool preserves the `assistant_unavailable` 503 response.

Admission is reviewed code, not live runtime state. Every entry must carry a
real, complete run of the assistant admission harness with non-empty checks and
at least the default 60% score — required in the aggregate and, since
[ADR 0067](0067-assistant-write-path-is-guarded-by-code-not-by-model-choice.md),
in every dimension the run measured. Both committed marks satisfy that rule from
complete runs — Gemini across all three dimensions (2026-08-03), Cerebras across
two (2026-07-27, its `attachments` revalidation pending); a mark naming only
`reading` would predate the write-path questions and state nothing about writes. An
automated guard checks that marks name the same provider/model, have coherent
non-zero counts, and satisfy normal admission. There is no named exception: the
one that existed — Groq Llama 3.3 70B, the incumbent from before this gate,
carried as `grandfathered` with a partial 11/14 run — was retired with its
provider (#1278), so «admitted» and «in the pool» are now the same statement.

**A pool entry must be able to accept one turn, and that is a measured fact
(#1278).** Groq did not leave for quality: its free tier rejects the request
outright. The bare turn — system prompt plus the name, description and JSON
schema of every tool, before a word of conversation — measured 35.390
characters with 34 tools, which the three tokenizers read very differently: 9.231
input tokens for Gemini, 7.732 for Cerebras, and 14.285 for Llama 3.3 — whose free
tier allows 12.000 tokens per minute and refuses on arrival any single request that
alone exceeds that allowance. Slimming the prompt would not have saved it either: the
allowance is per *minute*, and one turn issues up to six requests inside it, each
re-sending the floor plus everything read so far. As the
third entry, Groq was only ever reached when the first two were cooling down —
so what looked like a fallback was a guaranteed failure with one extra round trip
of latency, and a `request too large` rejection deliberately persists no cooldown,
so every request tried it again. `bun run eval:floor` is the meter, `--live` adds
the per-provider token figure, and a CI test holds the character floor under a
reviewed ceiling so it cannot drift up unnoticed.

**The floor is a maintained figure, and duplication is what makes it grow
(#1342).** It reached 37.024 characters four days after #1278 measured it, one
write tool at a time, each description carrying its siblings' boilerplate.
Slimming brought it to **32.719** characters with 35 tools — 8.540 input tokens
for Gemini, 7.031 for Cerebras (measured live 2026-08-03) — and no rule was
dropped to get there: what was removed was the same rule stated twice. The
prompt and the tool descriptions are both re-sent on every step, so **when to
reach for a tool** is written once in the prompt and **how to fill that tool's
arguments** once in its own description; the two rules with a boundary in code
behind them (`connected-source-write-guard.ts`, `holding-id-provenance.ts`) are
stated once in the prompt and never per tool, guarded by prose tripwires in
`turn-floor.test.ts`. Because the prompt and the tool contract both changed, this
ADR's own revalidation rule fired: Gemini was re-run and its mark refreshed
(62/83 on the full three-dimension set, the first mark to carry `attachments`),
and a third run of the same day against pre-slice `main` scored 61/83, which is
how «no rule disappeared» was checked behaviourally rather than argued — check by
check, no rule-shaped check changed state. **Cerebras's revalidation is pending**
and its mark is knowingly stale: two attempts that day could not complete, the
second losing four of six questions to tokens-per-minute once the day's earlier
runs had spent its free-tier allowance, and an incomplete run may never become a
mark. Nothing in the pool's behaviour depends on it while Gemini remains the
first entry, but the mark does not describe the shipped contract until it is
re-run on a fresh allowance.

That slice also settled a question the meter had only assumed: between the two
floors both measured live — 35.390 and 32.719 characters, −7,55% — Gemini charged
−7,49% and Cerebras −9,07%, so **tokens track characters at roughly one to one**
and the cheap deterministic meter is a faithful proxy for the bill. Of the
remaining floor, 14.462 characters are tool descriptions, 10.127 their JSON
Schemas and 7.438 the prompt; the descriptions still hold the majority but carry
per-tool argument semantics rather than duplication, and the schemas are the
contract. Cutting materially further means offering fewer tools per turn, which
is a behaviour change and needs its own decision.

The pool is therefore two entries deep, and what happens when both are cooling
down is unchanged and deliberate: `assistant_unavailable` with status 503, the
same answer an empty pool has always given. Widening the pool again means either
a new provider that passes normal admission, or a second entry on an existing
provider — quotas are per model, so two Cerebras models would genuinely multiply
the margin — which is a change in the shape of the allowlist (one entry per
provider today) and needs its own decision.

Production chat and the live eval runner share one provider resolution seam: it
binds the candidate, its provider credential, SDK model, and stable label.
Production feeds that resolver only the first available allowlisted candidate;
the eval runner can still feed it an explicit candidate before admission. The
allowlist and ordering policy stay in a small catalog module, separate from SDK
factories and resolution. This prevents environment configuration from
introducing an unreviewed production model without making the admission harness
circular.

Priority is deterministic, not round-robin. For each hosted request, runtime
reads the deployment's provider cooldowns from the control plane, removes the
active entries, and tries the remaining credential-backed candidates until one
emits real output. A quota rejection, invalid credential, or 5xx before that
point moves invisibly to the next candidate and records a cooldown. After output
starts, the existing stream error path remains authoritative and no provider is
replayed. A request-too-large 429 may fail over for that request but never
creates persistent cooldown because it says nothing about other request shapes.
The user/IP rate limit is charged once before these attempts and stays independent
of provider state.

Cooldown policy and persistence are separate. The pure policy first honors
`retry-after-ms`, `Retry-After` seconds or HTTP dates, and provider messages such
as `try again in 45m`. Without reset information, daily token/request limits run
until the next UTC day while short quota windows use one minute. Transient 5xx
and rejected credentials use bounded defaults. The control plane upserts by
`(deployment_key, provider)` and keeps the later timestamp under concurrent
writes, so one serverless instance cannot shorten another instance's cooldown.
An entry returns automatically when its timestamp expires.

`WORTHLINE_CHAT_DEPLOYMENT_KEY` can set a stable explicit scope. Otherwise the
scope is `VERCEL_URL`, then `VERCEL_ENV`. A hosted process with a control plane
but none of those identities refuses to use a global cooldown bucket: the route
logs the configuration cause and safely uses the full pool. With no control-plane
URL, local development remains stateless and uses only the first
credential-backed entry. Cooldown reads and writes have a one-second bound. If
one fails or times out, the route logs the operation, provider where known,
classification, and error name/message; it then keeps the full pool available
rather than turning a control-plane incident into total assistant failure.

Revalidation is event-driven: rerun the harness and review a fresh mark whenever
a model ID, provider behavior, assistant system prompt, tool contract,
golden-question contract, or admission threshold changes, and when production
evidence suggests a material quality regression. An admitted entry that cannot be
revalidated must leave the pool — which is what finally happened to Groq: a
candidate that cannot accept the turn cannot be re-run, so it cannot hold a mark.
No named exception may be reintroduced for another provider or model.

## Operations

The normal admission flow is: run the live harness for one exact candidate,
review the machine-readable complete/pass verdict, copy the reviewed evidence,
then add the provider/model entry to the committed allowlist. Runtime never
admits from a live report. Revalidate on every event listed above before
refreshing the mark.

Provider attempts, rejection classifications, selections, and successful
cooldown writes are structured application logs. Read/write failures use
`Assistant provider cooldown ... failed`. To inspect current state in the
control-plane database:

```sql
SELECT deployment_key, provider, cooldown_until, updated_at
FROM provider_cooldowns
ORDER BY deployment_key, provider;
```

Compare `cooldown_until` with UTC now; expired rows are harmless because policy
ignores them. A controlled preview/demo smoke test should force the first
provider to reject before output, verify the next provider answers, repeat from
a second request/instance to observe the skip, advance/delete the cooldown to
verify recovery, and finally cool down all configured providers to verify the
unchanged `assistant_unavailable` 503 response.
