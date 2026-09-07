# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists. It points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**. Read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, proceed silently. Don't flag their absence; don't suggest creating them upfront. Producer skills create them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```text
/
|-- CONTEXT.md
|-- docs/adr/
|   |-- 0001-example-decision.md
|-- src/
```

Multi-context repo:

```text
/
|-- CONTEXT-MAP.md
|-- docs/adr/
|-- src/
    |-- web/
    |   |-- CONTEXT.md
    |   |-- docs/adr/
    |-- mobile/
        |-- CONTEXT.md
        |-- docs/adr/
```

## An ADR number is an address

Files are `NNNN-kebab-case-title.md`, and the number is cited from code comments,
tests, `CONTEXT.md` and other ADRs — so it must resolve to exactly one file. When
you write a new ADR, take the next number no file on disk uses; never reuse one
(#1704 renumbered four ADRs that all claimed 0096). The gate enforces this in
`tests/tooling/adr-numbering.test.ts`.

## Use the glossary's vocabulary

When your output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, either reconsider whether you're inventing project language or note the gap for a domain-doc pass.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding it.
