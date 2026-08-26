# The chat tool catalog is a registry of families

- Status: accepted
- Date: 2026-08-26
- Issue: #1588

## Context

ADR 0047 decided WHAT the assistant's chat tools are: thin conversational
wrappers over the agent-view read catalog, plus `propose_*` tools that persist a
draft a human confirms. It said nothing about where they live, and they all lived
in one place: `chat-tools.ts` reached 2.784 lines holding 39 tools, 19 JSON
schemas, the money formatter, the scope resolver, the chip resolver, and the
per-turn gates.

Two costs came out of that, and neither is aesthetic:

1. **Adding a proposal meant editing the file every proposal already edits.**
   The traspaso (#1482), the operation (#1374), the reconstruction amendment
   (#1423) and the reconcile (#1373) each landed as a new block in the same
   file, so the diffs collided and each review had to re-read a file nobody
   holds in their head.
2. **The turn's frontiers were reachable by accident.** `ingestionGated`,
   `unvalidatedEvidence`, the one-proposal-per-turn budget and the grounded-id
   set were closure variables in scope for all 39 tools. Nothing said which
   tool was entitled to which gate, and a new tool got every one of them for
   free — including the ones it must not bypass.

## Decision

The chat tool catalog is a **registry**: `createChatTools` says which families
exist and what wraps the whole set, and nothing else.

- **A family is a module.** `chat-tools/reads/*` for the read lenses,
  `chat-tools/proposals/*` for the `propose_*` lanes, plus
  `chat-tools/maintainer-alert.ts` for the one tool that is neither. Each
  exports one `(turn) => ToolSet` factory. Adding a proposal is a new module
  and one line in the registry.
- **Schemas are their own family group**, under `chat-tools/schemas/`. Proposal
  schemas split per family because each one is a large, family-specific
  argument shape. Read schemas share `schemas/reads.ts` because they are the
  opposite: small variations on one shared vocabulary (`scopeId`, `limit`,
  `cursor`, `holdingId`), three of them used by more than one read family.
- **A schema declares the DOMAIN type it produces.** `CorrectionInput`,
  `ReconstructionAmendmentOperation`, `AgentViewDataQualityCategory`,
  `MixedDocumentSegmentArg` — not a loose record the tool then casts. A cast at
  the call site is where the declared contract and the code drift apart, and
  five of them existed.
- **The turn is an explicit parameter, not a closure.** `ChatToolTurn`
  (`chat-tools/turn.ts`) carries the reader bound to this turn's `asOf`, the
  gates the route resolved, and the turn's two pieces of mutable state (the
  proposal budget, the grounded-id set). A family destructures what it needs, so
  the module states its entitlements: `reads/fire.ts` takes `catalogRead` and
  nothing else, and `reads/market-symbol.ts` takes no argument at all.

What does NOT change: the tool names, the descriptions, the JSON schemas and the
refusals. This is the module map only — with one deliberate exception, below.

The one thing that DOES change beyond the map is the tool list's **order**, which
the model sees. The old order was append-only history (`search_market_symbol` sat
between two proposals because that is where it was typed); it is now the family
map — every read, then every proposal, then the alert. The prompt floor is a
character count and is unaffected (#1342); if the admission harness ever shows the
order mattering, the fix is a declared order in the registry, not a return to
accident.

## Consequences

- The per-turn frontiers stay unforked by construction. Adding a gate is an edit
  to `input.ts` plus `turn.ts` — deliberately the one edit every family sees,
  because a family growing its own copy of the evidence boundary is the failure
  the seam exists against (#1248, #1257, #1263).
- The registry is the census. `unvalidated-evidence-gate.ts` and
  `proposal-card-presence.test.ts` both enumerate `createChatTools` and fail on a
  `propose_*` tool that is missing a classification or a card parser; a family
  module that is never registered fails those tests rather than shipping dark.
- Duplication that the single file already carried — the error-envelope relay in
  every read, the `proposal_persistence_unavailable` guard in every proposal — is
  now spread across modules instead of stacked in one. It was not introduced
  here and collapsing it would change execute bodies, which this decision
  explicitly does not do. It is the next thing to look at, on its own issue.
- `chat-tools.ts` keeps its path and its exports (`createChatTools`,
  `chatToolStores`, `ChatReadStore`, `ChatToolsInput`), so the chat route, the
  eval harness (#1265) and the turn-floor measurement are untouched.
