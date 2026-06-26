# The shared AI baseline is rate-limited

The free shared assistant baseline backed by a provider key such as `GROQ_API_KEY` is rate-limited from the first slice. Hosted usage is limited per user or workspace when authenticated, and by a coarser fallback such as IP when no user is available; local usage can remain effectively unmetered because the developer controls the environment.

This treats the shared key as a bounded product resource, not infrastructure magic. The limit can be simple at first, but every request path using the shared key should pass through it before calling the provider. On serverless the counter cannot live in process memory across invocations; reuse the existing control-plane database as the shared store rather than adding new infrastructure. The Vercel AI Gateway spend ceiling (ADR 0050) is a coarse backstop, not a substitute for this per-user limit.
