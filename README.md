# worthline

Local-first net worth dashboard for personal and household tracking — with a
production LLM agent that can propose changes to the ledger, and an eval harness
that decides which models are allowed to.

Live: [worthline-web.vercel.app](https://worthline-web.vercel.app) ·
Domain model: [`CONTEXT.md`](CONTEXT.md) · Decisions: [86 ADRs](docs/adr/)

## The agent

Most of the interesting engineering in this repo is in
[`apps/web/app/asistente`](apps/web/app/asistente). The assistant answers questions
about a household's finances and prepares changes to them, which means every
mistake it makes is a mistake about someone's money. The architecture is shaped
around that.

**39 tools, and none of them writes.**
[`chat-tools/`](apps/web/app/asistente/chat-tools) declares 23 read tools
(`get_financial_context`, `get_calculation_trace`, `get_snapshot_history`…),
14 `propose_*` tools, and 2 others — one module per family, assembled by the
registry in [`chat-tools.ts`](apps/web/app/asistente/chat-tools.ts) (ADR 0086). No tool the model can call mutates a holding,
an operation or a snapshot. A `propose_*` call persists a **proposal**; applying it
is a separate Server Action a human confirms in the UI, which goes through the
command frontier (ADR 0062). The model drafts; the person commits.

**Three evals, scored apart.**
[`eval/`](apps/web/app/asistente/eval/) is a live admission gate: it runs one
explicit provider/model pair against the production system prompt, tools and a
pinned clock, and scores `reading`, `tool-discipline` and `attachments`
**separately**. Admission requires the aggregate *and every dimension* to clear the
threshold — because one blended ratio is how a model scored 88% on the day it faked
a proposal card in prose and invented a holding id. Two numbers hid one defect.

```bash
bun run eval:assistant -- --provider google --model gemini-3.1-flash-lite
```

**The graders call the production rules.** The fabrication grader invokes
`claimsPreparedProposal` from the runtime guard itself rather than restating it, so
the measurement cannot drift away from the frontier it measures. Same for the
unvalidated-evidence check. See [`eval/README.md`](apps/web/app/asistente/eval/README.md)
for why each dimension exists and how to read a write-path score (most of those
questions grade the model for *not* doing something, so a model that barely acts
still scores respectably — read the number next to the tool trace).

**A model cannot enter the pool without dated evidence.**
[`provider-pool.ts`](apps/web/app/asistente/provider-pool.ts) types every entry with
its `AdmissionEvidence`: run date, per-dimension scores, whether the run was
complete. Marks are validated at import time. Today the pool is Google
`gemini-3.1-flash-lite` and Cerebras `gpt-oss-120b`, with failover and per-provider
cooldown; Groq's Llama 3.3 70B was retired on a measurement, not a hunch — its free
tier allows 12,000 tokens/minute and the bare turn measures 14,285 in its own
tokenizer (`bun run eval:floor -- --live`).

**Runtime guards, each from a real incident.**
[`fabricated-proposal.ts`](apps/web/app/asistente/fabricated-proposal.ts) (prose that
claims a ceremony that never happened),
[`unvalidated-evidence-gate.ts`](apps/web/app/asistente/unvalidated-evidence-gate.ts)
(rewriting a history from a series nobody parsed),
[`anchor-correction-gate.ts`](apps/web/app/asistente/anchor-correction-gate.ts),
[`connected-source-write-guard.ts`](apps/web/app/asistente/connected-source-write-guard.ts).

**Cost is measured, not assumed.** `turn-floor.ts` + `token-budget.ts` +
`token-metering.ts` price what a single turn costs before it is sent;
`bun run eval:floor` prints the floor.

**Documents are a dimension of their own.** PDFs, spreadsheets and photos go through
typed extractors with an extraction contract and a preview
(`attachment-*-extractor.ts`), because behaviour over an uploaded file does not
follow from behaviour over a typed question — and a file is where the money moves.

**MCP server.** [`app/api/mcp/route.ts`](apps/web/app/api/mcp/route.ts) serves the
read catalogue to external clients over OAuth (`worthline:read`), rate-limited
pre-auth, with tenant isolation under test
([`route.tenant-isolation.test.ts`](apps/web/app/api/mcp/route.tenant-isolation.test.ts)).

## Commands

Install dependencies (requires [Bun](https://bun.sh) 1.3+ and Node.js 26+):

```bash
bun install
```

Run the local web app:

```bash
bun run dev
```

Run the fast verification gate (inner-loop and default CI check):

```bash
bun run verify
```

`verify` runs `typecheck` + `typecheck:e2e` + `biome ci` + `test` without invoking
a full `next build`. Typecheck and test are orchestrated by Turborepo, so unchanged
packages are skipped across runs ("FULL TURBO" cache hit). Biome (lint + format)
runs at the repo root. The suite is ~6,900 unit tests across 651 files.

Run the full production/deploy gate (pre-push / before deploy):

```bash
bun run build
```

This still triggers `apps/web`'s `bun --bun next build`, which catches Next-generated
route/page types that plain `tsc` does not see. See [`docs/agents/bun-runtime.md`](docs/agents/bun-runtime.md).

Run only tests related to changed files (useful while iterating):

```bash
bun run test:related
```

The three eval harnesses (all live, all opt-in — they cost provider calls):

```bash
bun run eval:assistant -- --provider google --model gemini-3.1-flash-lite
bun run eval:extractor      # document extraction, apps/web/app/asistente/eval/extractor
bun run eval:floor -- --live  # what one turn costs
```

Turborepo caches tasks under `.turbo/` locally. **Remote cache** (Vercel, free on Hobby) is enabled in CI when `VERCEL_TOKEN` and `TURBO_TEAM` are set — see [`docs/agents/turbo-remote-cache.md`](docs/agents/turbo-remote-cache.md).

## Project Layout

- `apps/web`: Next.js dashboard (RSC-first) and the assistant.
- `apps/web/app/asistente`: the agent — tools, prompt, guards, proposals, extractors.
- `apps/web/app/asistente/eval`: the admission gate and its golden questions.
- `packages/domain`: shared net worth domain model and calculations.
- `packages/db`: SQLite persistence and local data path handling.
- `packages/pricing`: price provider contracts and manual fallback placeholder.
- `packages/contracts`: shared TypeScript contracts for web, domain, db, and future mobile.

The package boundaries are intentionally mobile-ready: the future Expo app should reuse
`packages/domain`, `packages/contracts`, and provider contracts instead of copying web logic.

Decisions live in [`docs/adr/`](docs/adr/), the domain vocabulary in
[`CONTEXT.md`](CONTEXT.md), and how the UI is meant to look and feel in
[`docs/design-system.md`](docs/design-system.md) and
[`docs/interaction-patterns.md`](docs/interaction-patterns.md).

## Local Data

By default the app stores SQLite data under:

```text
.local/worthline/worthline.sqlite
```

The directory is ignored by git. Override it with either:

```bash
WORTHLINE_DATA_DIR=/path/to/private/data bun run dev
```

or:

```bash
WORTHLINE_DB_PATH=/path/to/worthline.sqlite bun run dev
```

## Authentication (optional)

worthline can run in two modes:

- **Local no-auth mode** (default): `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and
  `AUTH_SECRET` are unset. The app opens a local SQLite file and works offline,
  exactly as before.
- **Hosted mode**: set `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`,
  `WORTHLINE_CONTROL_PLANE_DB_URL`, `WORTHLINE_DB_AUTH_TOKEN`, `TURSO_ORG`, and
  `TURSO_API_TOKEN`. Signed-out visitors are redirected to `/login`; signed-in
  users open their own per-workspace libSQL database, provisioned on first login
  through the control plane (ADR 0030).

Setting only **one** of `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` is refused at
startup: every gate reads that pair as absent, so the app would silently serve
itself with no sign-in wall. A `VERCEL_ENV=production` deploy likewise refuses to
boot until all seven hosted vars are set (#1181) — locally, an empty env stays
local no-auth mode as before.

To set up Google sign-in:

1. Create an OAuth 2.0 Web application credential in [Google Cloud Console](https://console.cloud.google.com/).
2. Add the authorized redirect URI:
   - Local: `http://localhost:3000/api/auth/callback/google`
   - Production: `https://<your-domain>/api/auth/callback/google`
3. Copy the Client ID and Client Secret into `.env.local` as `AUTH_GOOGLE_ID`
   and `AUTH_GOOGLE_SECRET`.
4. Generate `AUTH_SECRET` with `openssl rand -base64 32`.

The assistant needs at least one pooled provider key
(`GOOGLE_GENERATIVE_AI_API_KEY` or `CEREBRAS_API_KEY`); with none set, the app runs
and the assistant does not.

No auth, telemetry, cloud sync, personal spreadsheet data, or machine-specific absolute paths
are required for the bootstrap slice.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) — the
short version is: run `bun run verify` before you push, follow Conventional
Commits, and respect the design-system and interaction-pattern docs for any UI
change.

## License

Copyright © 2026 Jose Enrique Narváez Gago.

worthline is licensed under the [GNU Affero General Public License v3.0](LICENSE)
(AGPL-3.0-only). If you run a modified version as a network service, you must make
your source available under the same terms.
