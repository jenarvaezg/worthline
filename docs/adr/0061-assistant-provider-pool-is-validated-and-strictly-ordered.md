# The assistant provider pool is validated and strictly ordered

The shared financial assistant resolves models from one committed allowlist. Its
default priority is strict: Google Gemini 3.1 Flash Lite, then Cerebras GPT OSS
120B, then Groq Llama 3.3 70B. The first entry whose own provider credential is
present is selected. Local, preview, production, and demo use this same default;
`WORTHLINE_CHAT_PROVIDER_ORDER` may only reorder providers already in the
allowlist. Missing credentials remove entries rather than producing a provider
error, and an empty pool preserves the `assistant_unavailable` 503 response.

Admission is reviewed code, not live runtime state. A normal entry must carry a
real, complete run of the assistant admission harness with non-empty checks and
at least the default 60% score. The committed Gemini and Cerebras marks satisfy
that rule. Groq is the incumbent from before this gate and is explicitly
grandfathered: its revalidation exhausted the free daily token allowance after
6 of 12 questions. Its partial 11/14 check result and the reason remain visible;
it is not represented as a normal passing run. An automated guard checks that
marks name the same provider/model, have coherent non-zero counts, and satisfy
either normal admission or this one named exception.

Production chat and the live eval runner share one provider resolution seam: it
binds the candidate, its provider credential, SDK model, and stable label.
Production feeds that resolver only the first available allowlisted candidate;
the eval runner can still feed it an explicit candidate before admission. The
allowlist and ordering policy stay in a small catalog module, separate from SDK
factories and resolution. This prevents environment configuration from
introducing an unreviewed production model without making the admission harness
circular.

Priority is deterministic, not round-robin. Runtime failover and cooldown are a
later slice; this decision only establishes the ordered candidates and selects
the first usable one. Revalidation is event-driven: rerun the harness and review
a fresh mark whenever a model ID, provider behavior, assistant system prompt,
tool contract, golden-question contract, or admission threshold changes, and
when production evidence suggests a material quality regression. A normally
admitted entry that cannot be revalidated must leave the pool. The Groq
exception must be removed or replaced by a normal mark once a complete run is
available; it must not be copied to another provider or model.
