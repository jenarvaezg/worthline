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
in every dimension the run measured. The committed Gemini and Cerebras marks
satisfy that rule with complete two-dimension runs; a mark naming only `reading`
would predate the write-path questions and state nothing about writes. An
automated guard checks that marks name the same provider/model, have coherent
non-zero counts, and satisfy normal admission. There is no named exception: the
one that existed — Groq Llama 3.3 70B, the incumbent from before this gate,
carried as `grandfathered` with a partial 11/14 run — was retired with its
provider (#1278), so «admitted» and «in the pool» are now the same statement.

**A pool entry must be able to accept one turn, and that is a measured fact
(#1278).** Groq did not leave for quality: its free tier rejects the request
outright. The bare turn — system prompt plus the name, description and JSON
schema of the 34 tools, before a word of conversation — measures 35.390
characters, which the three tokenizers read very differently: 9.231 input tokens
for Gemini, 7.732 for Cerebras, and 14.285 for Llama 3.3 — whose free tier allows
12.000 tokens per minute and refuses on arrival any single request that alone
exceeds that allowance. Slimming the prompt would not have saved it either: the
allowance is per *minute*, and one turn issues up to six requests inside it, each
re-sending the floor plus everything read so far. As the
third entry, Groq was only ever reached when the first two were cooling down —
so what looked like a fallback was a guaranteed failure with one extra round trip
of latency, and a `request too large` rejection deliberately persists no cooldown,
so every request tried it again. `bun run eval:floor` is the meter, `--live` adds
the per-provider token figure, and a CI test holds the character floor under a
reviewed ceiling so it cannot drift up unnoticed.

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
