## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `jenarvaezg/worthline`. See `docs/agents/issue-tracker.md`.

### Triage labels

The repo uses the default Matt Pocock skill label vocabulary as GitHub labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo with domain docs rooted at `CONTEXT.md` and ADRs under `docs/adr/`. See `docs/agents/domain.md`.

### Design system

Any UI change must follow the style guide in `docs/design-system.md` (tokens, typographic hierarchy, color semantics, component rules). Tokens live in `apps/web/app/globals.css`.

### Interaction patterns

Any front interaction (toggles, filters, mutations, navigation, charts) must follow `docs/interaction-patterns.md` (RSC-first, ADR 0036): server-render the figures, client-side view toggles with no page reload, URL mirrored via `pushState`, optimistic mutations, flash-free navigation, interaction logic in pure testable modules. It complements `docs/design-system.md` (how it looks) with how it feels to touch.
