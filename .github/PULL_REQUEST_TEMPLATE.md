<!--
Thanks for contributing to worthline! Please fill this in and tick the checklist.
See CONTRIBUTING.md for the full guidelines.
-->

## Summary

<!-- What does this PR do, and why? One or two sentences is fine. -->

Closes #<!-- issue number; use an English keyword so GitHub auto-closes it -->

## Type of change

- [ ] `fix` — bug fix
- [ ] `feat` — new feature
- [ ] `refactor` / `perf` — no behavior change / performance
- [ ] `docs` / `chore` / `ci` — non-code or tooling

## Verification

<!-- Tick what you actually ran. The gate must be green before review. -->

- [ ] `npm run verify` passes (typecheck + test + lint + **format**)
- [ ] `npm run build` passes — required if this touches `apps/web` routes/pages
- [ ] Tests added or updated for the behavior changed (suite stays green)

## Conventions

- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] Added/updated an ADR under `docs/adr/` if this makes an architectural decision
- [ ] UI changes follow `docs/design-system.md` and `docs/interaction-patterns.md`

## Notes

<!-- Anything reviewers should know: trade-offs, follow-ups, screenshots for UI changes. -->
