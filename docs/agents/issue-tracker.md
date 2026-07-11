# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `jenarvaezg/worthline`.
Use the `gh` CLI for issue tracker operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`.
- **Create a sub-issue**: `gh issue create --parent <number-or-url> --title "..." --body "..."`.
- **Read an issue**: `gh issue view <number> --comments`, including labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments`.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- **Close**: `gh issue close <number> --comment "..."`.
- Infer the repo from `git remote -v`; `gh` does this automatically when run inside this clone.

## Agent-readiness labels

- **`ready-for-agent`** — fully specified and ready for an AFK agent.
- **`ready-for-human`** — requires human implementation.
- **`agent-lite`** — a *subset* of `ready-for-agent`: bounded, backend-only tasks
  (logic / engine / storage / API, **no visual frontend**) that are safe to hand to
  a **weaker or cheaper** model. Apply it on top of `ready-for-agent`, never alone.
  Reach for it when a ticket has a closed spec, deps already merged, existing tests
  as a safety net, and no design decisions left open. Prefer *not* to add it to
  novel/high-context work, wholesale refactors, or anything with a UI surface.

  ```sh
  gh issue edit <N> --add-label ready-for-agent,agent-lite
  # Find the queue for a weak model:
  gh issue list --label agent-lite --state open
  ```

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `jenarvaezg/worthline`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
