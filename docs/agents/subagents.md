# Subagents

How subagents are used in this repo: which ones apply, which are vetoed, what
briefing they get, and which gate they close with.

The reason this document exists is context, not etiquette. The bottleneck here is
the main context window: a gate run dumps thousands of lines of Turbo and vitest
into it, and that is exactly the context needed intact to reason about the change.
A subagent is worth spawning when it reads a lot and returns a little.

## One agent, one trade

- No agent carries the whole toolbox. A reviewer gets read-only tools
  (`Read`, `Grep`, `Glob`, and `Bash` only when it has a command to run);
  it never gets `Write` or `Edit`.
- Agents defined for this repo live in `.claude/agents/`, versioned in git.
  The rest of `.claude/` stays ignored — see the `.claude/*` / `!.claude/agents/`
  pair in `.gitignore`.
- The parent never sees a subagent's transcript, only its final report. So the
  report's shape belongs in the prompt: say what to return and how long it may be,
  or you get a narration of the work instead of the finding.

## Vetoed in this repo, with the reason

The reason matters more than the list. When someone adds a new global agent, the
criterion has to keep working.

| Agent | Why it does not apply here |
| --- | --- |
| `database-reviewer` | Speaks PostgreSQL and Supabase — RLS policies, `EXPLAIN ANALYZE`, connection pooling. The stack is libsql/Turso with Drizzle: there is no Postgres planner to advise on, migrations are ordered SQL replayed by `packages/db`, and interactive transactions do not work over `:memory:` — `store-context.ts` hand-rolls `BEGIN`/`COMMIT`/`ROLLBACK` for local clients. Its advice is not wrong so much as addressed to a different database. |
| `python-reviewer` | There is no application Python to review. The only Python in the tree lives under `.local/`, which is gitignored because it holds real data. |
| `doc-updater` | It runs `/update-codemaps` and writes `docs/CODEMAPS/*`, which does not exist here. Domain documentation is `CONTEXT.md` plus `docs/adr/` — see [`domain.md`](domain.md). |

**The criterion.** Before invoking a global agent, check three things about its own
description: does it name the stack this repo actually runs, do the paths it writes
to exist on disk, and is there tracked code of the kind it reviews? A "no" to any of
them means its briefing was written for a different repo, and it will spend the
budget confidently reviewing something that is not here.

Global agents that do apply unchanged: `Explore` and `general-purpose` for fan-out
search, `code-reviewer` and `security-reviewer` on a diff, `e2e-runner` for the
Playwright journeys, `build-error-resolver` for a red typecheck.

## The briefing: claim + evidence

A subagent gets exactly two things:

- **claim** — the issue: `gh issue view <n> --comments`.
- **evidence** — the diff: `git diff main...HEAD` (three dots: the change, not the
  drift of `main` underneath it).

It never gets the implementation plan, the commit-by-commit story, or the
implementer's reasoning. A reviewer who is told *why* an approach was chosen tends
to ratify it; the point of the second context is that it has not already agreed.

Everything else the agent needs it reads itself, from the paths the diff names. Point
it at the canon rather than pasting the canon: [`CONTEXT.md`](../../CONTEXT.md),
the relevant `docs/adr/`, [`design-system.md`](../design-system.md),
[`interaction-patterns.md`](../interaction-patterns.md). Duplicated canon goes stale
in exactly the place nobody looks.

## The closing gate

**No subagent closes with "done."** It closes with the gate output.

- `bun run verify` always — typecheck, e2e typecheck, Biome, tests. A Biome
  *warning* fails it.
- `bun run build` as well when the change touches types Next generates — routes,
  page props, `searchParams`. A green test run is not a green build; `tsc --noEmit`
  cannot see those types.
- **In a worktree, `bun install` first.** Otherwise `@worthline/*` resolves to the
  parent checkout's `node_modules` and the agent gates a different tree than the one
  it edited.

Full detail of what each script covers: [`verification-gate.md`](verification-gate.md).

A report that says the work is complete without a gate line pasted into it is an
unverified report — treat it as a claim, not a result.

## When not to fan out

Multi-agent fan-out is not the default mode here. The bottleneck is burnt context,
not wall-clock parallelism, and every extra agent is another briefing to write and
another report to reconcile.

- Spawn one when it reads much more than it returns: running a gate, sweeping a
  large surface, reviewing a diff against a checklist.
- Do not spawn several to "get more opinions" on the same diff. Agents that share a
  briefing converge on the same answer, and the agreement reads as confirmation.
- Review of someone else's work stays a **single** Opus gate. Splitting it across
  cheaper agents buys throughput at the cost of the judgment that pass exists for.
- Do not delegate a lookup you already know the file for. The delegation costs more
  than the read.

## Agents defined in this repo

None yet. Each of the first tranche registers itself here as it lands:
`gate-runner` (#1623), `calc-reviewer` (#1624), and `wl-db-reviewer` plus
`front-reviewer` (#1625).
