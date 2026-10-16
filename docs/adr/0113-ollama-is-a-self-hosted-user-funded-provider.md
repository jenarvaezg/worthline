# Ollama is a self-hosted, user-funded provider

A user's Ollama server enters the assistant provider pool as a **self-hosted**
entry: activated by a base URL (`WORTHLINE_OLLAMA_BASE_URL`), served model chosen
per user (`WORTHLINE_OLLAMA_MODEL`, no default), exempt from the shared-baseline
admission gate, and carrying a **reference mark** instead of an admission. This
amends ADR 0061's «no named exception» rule with one narrow, code-typed class —
and nothing else. This is the self-hosted extension of ADR 0050: the money and the
hardware are the user's, so worthline's shared-baseline quality guarantee, which
exists to protect a pool worthline funds and many users share, has nothing to weigh
in on it.

The entry is ordinary in every mechanical respect. It is a member of the
validated provider pool and of `WORTHLINE_CHAT_PROVIDER_ORDER`; it must have a
capacity card (the committed reference tag's), its prompt budget is derived like
any other's, a rejected turn classifies and fails over like any other's, and a
down or un-reached server is `provider_unavailable`, not a dead turn. What it is
not is an admission: the harness measures one fixed candidate pair, and a
self-hosted entry serves a user-chosen model that does not exist in our code, so
passing a run could not vouch for what the user actually serves.

## «Admission» becomes two statements

For a **shared-baseline** entry, «admitted» and «in the pool» remain the same
statement (ADR 0061). For a **self-hosted** entry they split:

- In the pool is the *provider class*, validated at the provider level
  (`isAdmittedProvider`), so `requireAdmission` cannot reject the user's own tag.
- The *mark* is a `reference` run of the committed reference tag
  (`ollama/llama3.2:3b`), measured against a real server and committed however it
  came out — incomplete, below threshold, or even zero is a legitimate record.
  «Permit it not to fail» is explicit: the gate does not veto a small local model.

The validator still refuses a missing or incoherent reference mark, a mark naming
another candidate, and a self-hosted status on a shared-baseline entry (and the
reverse). The shared-baseline rules — incomplete runs never admit, no arbitrary
models from the environment — are untouched.

## The model conundrum is resolved by who pays

ADR 0061 pins provider→model pairs because it governs a pool worthline funds.
`WORTHLINE_CHAT_MODEL` was retired precisely so the environment could not inject
an unreviewed model into a shared spend. A self-hosted server inverts both
premises: the user pulls the model, the user serves it, and the user pays for it.
Pinning one tag the user must have pulled would defeat the point of
«connect to my server»; honoring the tag they actually serve is a configuration
choice, not an unreviewed production model riding a shared budget. The model is
therefore env-selected per user, applied only to the self-hosted slot in the pool
mapping (`resolveAllowedProviderModels`), while the eval seam stays faithful to
exactly the `--model` it names.

## The reference run is still a revalidation event

The system prompt, tool contract, and golden-question contract changes that force
a shared-baseline re-run (ADR 0061) also date the reference run: its point is to
keep the recorded interaction honest about how a turn actually lands on a small
local box, so a stale reference mark is rewritten, not edited in place. The
difference is that a reference run may fail and still be committed, because its
verdict was never the reason to admit.

## Operational notes

- `WORTHLINE_OLLAMA_BASE_URL` is the whole activation: the OpenAI-compatible
  endpoint root (e.g. `http://127.0.0.1:11434/v1`, the default Ollama port's
  `/v1`). API key sent only when `WORTHLINE_OLLAMA_API_KEY` is set (most servers
  need none). Reachability is the deploy's concern: localhost reaches a local
  server, and a hosted process must point at a URL the runtime can reach (a tunnel
  or a self-hosted endpoint).
- Context is the operative bound: Ollama serves a short default `num_ctx`, and a
  server below the turn floor (~40 300 characters) rejects the request, which
  classifies as `request_too_large`/`provider_unavailable` and fails over. The
  capacity card documents the model's native 128 K window, not a server's default.
- The provider runs without `includeUsage`, so Ollama streams no token usage; the
  token meter records nothing for it, which it already tolerates.
- Session/OAuth and the vision extractor are untouched: the extractor stays
  Google-only (ADR 0063) and is not part of this pool.