# Assistant evals — the model-quality gate (#668, S6)

CI proves the assistant **plumbing** with canned streams; it deliberately never
calls a live provider. This harness is the other half: it measures whether the
shared cheap baseline model actually **reads tool outputs correctly**.

The realistic failure of a cheap baseline is not inventing facts — the tools
ground those (ADR 0048) — but **misreading** them: confusing net worth with
liquid net worth, attributing a contribution-driven delta to market movement, or
answering confidently from a stale figure. The golden set targets exactly that.

## Run it

```bash
npm run eval:assistant                       # uses the current baseline model
WORTHLINE_CHAT_MODEL=groq/other-model npm run eval:assistant   # compare a candidate
```

It reads the same provider config as the app (`AI_GATEWAY_API_KEY` → gateway,
else `GROQ_API_KEY` → Groq direct; locally loaded from `apps/web/.env.local`).
With no key it **skips cleanly** with a message — it is not part of the CI gate.

The run pins the demo clock (`WORTHLINE_DEMO_NOW`, default `2026-06-01`) so the
seeded personas — and therefore the expected answers — are deterministic, and
prints a pass/fail table headed by the exact `provider · model` evaluated.

## It is the pre-swap gate

The gateway makes changing the baseline model/provider a mere config change —
which is exactly why a swap must not be blind. **Rerun this before changing the
baseline** and compare the table to the incumbent's. A regression in figure
attribution, delta attribution, or missing-fact honesty is a reason not to swap.

## What it checks (structured, not string-matching)

Each golden question (`golden.ts`) asserts structural properties via the pure
graders (`graders.ts`, unit-tested in CI):

- **Figure attribution** — net worth vs liquid net worth vs housing equity.
- **Delta attribution** — market move vs contribution.
- **Missing-fact honesty** — declines to invent a figure worthline doesn't hold
  (spending, pre-history returns) instead of guessing.
- **Sources cited** — proposes a clickable internal source.
- **Spanish by default.**
