# The assistant layer is a shell and a card per proposal

- Status: accepted
- Date: 2026-08-26
- Issue: #1589

## Context

The assistant's client layer had one file: `assistant-layer.tsx`, 2.577 lines
holding the FAB, the panel, the onboarding surface, the composer, the transport,
the conversation renderer, the quick-action resolvers — and the twelve proposal
cards, which were 1.600 of those lines.

The cards are the part that grows. Every proposal the assistant learnt to make in
2026 — the reconstruction (#1053), the alta (#1105), the baja/restauración
(#1106), the reconcile (#1108), the early repayment (#1245), the dated operation
(#1374), the dictated traspaso (#1482) — landed as another block in the same
file. Two costs, neither aesthetic:

1. **Adding a card meant editing the file every card already edits.** The diffs
   collided, and each review had to re-read a file nobody holds in their head to
   answer a question about one card.
2. **A card could reach anything the panel had.** The cards sat in the same module
   scope as the transport, the message list and the panel's open/close state.
   Nothing said a card is entitled to the demo write-gate and its own proposal and
   nothing else — so the day one card wanted the conversation, it was already
   there for the taking.

This is the same shape as the tool catalog one file over (ADR 0086) and the
control plane (ADR 0087): a grab-bag that grew by appending, split into a
registry plus one module per member.

## Decision

The assistant layer is a **shell**, and each kind of proposal paints itself in its
own module.

- **The shell is the composer, the conversation and the transport.**
  `assistant-layer.tsx` keeps the FAB, the panel, the onboarding surface, the
  turn renderer, the quick-action resolvers and the app's own asides (`AppNote`).
  It holds no card markup — a guardian test asserts the `assistantProposal*`
  classes do not appear in it.
- **A kind of proposal is a module.** `proposal-cards/holding-creation.tsx`,
  `.../reconcile.tsx`, `.../transfer.tsx` and so on, each exporting its card
  component. The correction contract's two depths are two modules
  (`correction.tsx`, `reconstruction.tsx`) because they are two different cards;
  the trash card stays one module for removal and restoration because it is one
  card with two folios (#1106).
- **The registry is `proposal-cards.tsx`**, sibling of the directory the way
  `chat-tools.ts` is sibling of `chat-tools/`. It says which card paints which
  kind and nothing else. Adding a proposal is a module plus one `case`.
- **A card's entitlements are a declared type.** `ProposalCardGate`
  (`proposal-cards/gate.ts`) is the demo write-gate and its message; a card takes
  that and its own parsed proposal. It cannot reach the conversation, the
  transport or the panel's state, because they are not in its module scope any
  more. One card takes LESS: the valuation card has never had a demo-gate message
  to print, so the registry hands it `mutationsDisabled` alone. Widening it here
  would put a sentence on screen that the card does not print today — the
  asymmetry is preexisting, and the registry is where it is finally visible.
- **The kinds are enumerated once.** `proposal-card-presence.ts` remains the
  single table of «did this tool answer become a card» — the one the
  fabricated-ceremony guard reads too (#1468) — and the registry's switch is
  exhaustive over its union, so a new kind fails the typecheck until it has a
  card.

What does NOT change: the cards themselves. Same markup, same copy, same
confirms, same server actions, same classes. The UI tests that render the layer
and click through the cards were untouched by this change and stayed green,
which is the evidence that no pixel moved.

## Consequences

- The design-system guardian now counts the paper register (twelve
  `assistantProposalKind` labels, five `assistantProposalFolio` footers) over the
  card directory instead of over the shell, and additionally asserts the shell
  carries none of it. The second half is the decision made enforceable: the way
  this split unravels is a thirteenth card written where the twelve used to live.
- Shared card wording moved to `proposal-cards/card-copy.ts` (money formatting,
  the ambiguous-fund note of #1366, the apply-result sentence) and the `srOnly`
  mutation status to `proposal-cards/mutation-status.tsx` — which is also the one
  place that sees an `applied` transition for any kind, so the onboarding stamp
  of #1169 keeps its single seam.
- The duplication the single file already carried is now visible instead of
  stacked. Eleven of the twelve cards repeat the same skeleton: the two
  `useState`/`useTransition` pairs, the `settled` / `actionsDisabled` derivation,
  the applied-or-blocked sentence and the Confirmar / Descartar pair. Spread over
  twelve modules it is finally legible as one shape — and collapsing it would
  change render bodies, which this decision explicitly does not do (same call as
  ADR 0086). It is the next thing to look at, on #1617. **Done — see the
  amendment below.**
- The shell is still 798 lines and still changes for more than one reason: the
  floating panel and the full-screen onboarding surface share it. That split was
  not in this slice's scope and is not decided here.
- The cards are now testable one at a time. Today every card test drives the whole
  layer (`assistant-layer-*-card.test.tsx`), which is the right level for the
  turn-to-card path and the wrong one for a card's own copy. Those tests are left
  as they are — moving them would change what is being asserted, which this
  decision does not do — but a new card can be tested directly.
- `assistant-layer.tsx` keeps its path and its default export, so the launcher's
  dynamic import (#1192), the onboarding route (#1168) and every existing test
  are untouched.

## Amendment (2026-08-29, #1617): the repeated skeleton is one hook and one button row

Splitting the file made the duplication legible; this collapses it. Three modules
now hold what ten cards were each writing out:

- **`proposal-cards/proposal-mutation.ts`** — `useProposalMutation(gate, {confirm,
  discard})`. One piece of result state, one transition, and the one derived truth
  both buttons read: a settled proposal (`applied` or `discarded`) has nothing left
  to act on, so `actionsDisabled` is `pending || mutationsDisabled || settled`.
  It takes **thunks**, not the server actions: the reconstruct card's confirm
  re-sends the series the user kept and the reconcile card's sends its curated
  decisions, so the closure over the render is what makes «what you see is what is
  written» true for both.
- **`proposal-cards/proposal-outcome.tsx`** — the `aria-live="polite" role="status"`
  paragraph, and the demo gate's sentence in its place until the card acts. A card
  declares `applied`: a string when the sentence is fixed, a function when it reads
  the payload back (the reconcile batch counts what it created) or also picks the
  tone (`historyReconstructedCopy` makes a reconstruction a warning when captures
  went without the debt, #1438).
- **`proposal-cards/proposal-actions.tsx`** — the Confirmar / Descartar pair.
  `confirmDisabled` is the card's OWN extra condition, added to the shared one and
  never replacing it: the correction's `verified`, the reconcile's non-empty batch,
  the reconstruction's `canConfirm`.

**What stays out, and why.** The three cards whose ceremony genuinely differs keep
their own: the statement card (its discard is a reducer that REPLACES the card with
a status paragraph and moves focus to it), the valuation card (its discard unmounts
the card), and the mixed-document card (a single «Confirmar todo», no discard). The
balance-history card takes the hook and the outcome but keeps its lone button: its
proposal has no discard, so there is no pair, and wrapping one button in
`.assistantProposalActions` would add a node the card has never painted. That is the
rule this amendment followed throughout — if the shared piece moved a node, the card
stayed out and it is written down here.

No markup, copy or class changed; `proposal-skeleton.test.tsx` pins the shared
skeleton's exact HTML and, in the same file, the list of cards outside it, so a
card silently re-growing its own copy fails a test instead of drifting.
