# Assistant evals — admission gate

This live harness decides whether one exact provider/model pair is eligible for
the shared assistant pool. It uses the production system prompt, tools, golden
questions and pinned demo clock, but selects its candidate explicitly: it never
changes or reads the production model configuration.

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
Cerebras, and 8 for Groq.

## Output and decision

Human progress and the pass/fail table go to stderr. A stable JSON report goes
to stdout and, when `--output` is supplied, to that file. It contains:

- schema version, provider, model, real start/finish timestamps;
- one result per attempted question, including status, every named check, and
  passed/total check counts;
- whole-run passed/total counts, ratio, threshold and admission decision;
- an explicit `complete` flag.

The default threshold is 60% and can be raised with `--threshold 0.7`. Admission
requires both a complete run and a score at or above the threshold. A partial
run, a zero-check run, or a score below the threshold exits non-zero. Provider
errors remain visible per question and their question checks count as failed.

## Committed evidence

`admission-evidence.ts` contains the reviewed results from #841/#842 in the
shape needed by the pool allowlist in #957. Gemini and Cerebras are normal
admissions because their runs were complete and cleared 60%. The incumbent
Groq model is represented separately as `grandfathered`, with the reason and
its partial 6/12-question run; it is not presented as satisfying the normal
rule.

Re-run and refresh a normal admission mark whenever its model or the system
prompt changes, or when provider behavior materially degrades.

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
