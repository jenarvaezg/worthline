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

## Wayfinder maps

Wayfinder maps (`wayfinder:map` + child tickets labeled `wayfinder:research`,
`wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`) track **decisions,
never implementation**. Implementation always leaves the map as separate
`ready-for-agent` issues or a compiled PRD issue — the map is the planning
artifact, the `ready-for-agent` queue is the execution artifact.

Conventions:

- **Every map is born with an explicit terminal handoff ticket** — the ticket
  whose closure means "the map is done and execution is specified". For
  product-shaped maps that ticket compiles a PRD issue (e.g. "Compilar y
  presentar el PRD"); for backlog-of-fixes maps where decisions are orthogonal,
  per-decision `ready-for-agent` emissions are fine, but the terminal ticket
  still exists so the map has an unambiguous finish line.
- **Close the map when its last decision closes** — always, regardless of shape.
  A map is a *planning* artifact; keeping it open through execution pollutes the
  wayfinder frontier (open unblocked children read as decisions to resolve, but
  execution tickets are not decisions). What differs by shape is **where the
  execution umbrella lives after the map closes**:
  - **Product-shaped map** (one coherent deliverable, interdependent slices, an
    acceptance gate): the terminal ticket **compiles a PRD issue**; the emitted
    `ready-for-agent` slices are **re-parented under the PRD** (sub-issues API,
    `replace_parent=true`), and the PRD is the umbrella that stays open until the
    work ships. Close the map. (Example: map #825 → PRD #915, slices #906–#913.)
  - **Backlog-of-fixes map** (orthogonal decisions): the per-decision
    `ready-for-agent` tickets are self-sufficient; no PRD. Close the map. (Example:
    map #783 → loose tickets #895/#896/#901/#903.)
  Always close with a handoff comment that links the PRD (or every emitted
  execution issue) and lists deferred threads. A map with all decisions resolved
  and no closing comment is a smell.
- Decision tickets record their outcome on close ("Decisión: X. Implementación:
  #N" or "cerrado sin ticket porque Y") so the map's decision log stays readable
  without re-opening threads.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `jenarvaezg/worthline`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
