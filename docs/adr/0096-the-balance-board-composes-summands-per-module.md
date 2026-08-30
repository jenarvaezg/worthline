# The balance board composes summands, one module per kind

## Context

`/patrimonio` is the balance sheet: assets left, liabilities right, the grouping
axis (#154) as subsections inside each pane, a footer that reconciles
Activos − Pasivos = Patrimonio neto, and the Papelera inside that footer.

`balance-board.tsx` had grown to 1.102 lines because every capability the board
learned arrived as another shape *in the same file*:

- the loose row (#271), with its warning badge, its derived-value hover (#303),
  its inline gain (#551, ADR 0040) and its actions menu;
- the managed-portfolio block (#1548, ADR 0085), a second kind of summand with
  its own header, its member breakdown and a weight bar cut by member;
- the fully-sold positions folded at the pane's foot;
- the Papelera with its three exits (#1549) and its two repairs (#1365);
- the optimistic shell (#521, interaction-patterns §4/§7/§8) whose
  `optimisticSubmit` closure every mutation form reached into;
- the URL-mirrored fold (§3).

The pure halves were already outside — `optimistic-board.ts` for the merge,
`board-fold.ts` for the fold — but everything that *rendered* was one file, and
the closure was what held it together: a form got its optimistic submit because
it happened to be written inside the component that owned the hook.

Two costs followed. Adding a kind of summand meant adding a variant to the file
that already had two, next to the pane that places them and the trash that
outlives them. And a change to the row — the most-touched surface on the board —
re-opened the file that owns the reconciliation.

## Decision

**The board composes summands. Each kind of summand, each folded surface, and the
optimistic shell is its own module under `_board/`; `balance-board.tsx` is the
assembly.**

1. **A kind of summand is a module.** `holding-row.tsx` renders a loose holding,
   `portfolio-block.tsx` a managed portfolio. The pane (`board-pane.tsx`) decides
   WHERE a summand goes and how heavy it reads; it never decides what one looks
   like. The next kind arrives as a module and one arm of the `unit.kind`
   dispatch — not as a variant grown inside the board.

2. **The optimistic shell is asked for, not closed over.** `useOptimisticBoard`
   returns `{model, isPending, optimisticSubmit}`, and a mutation surface takes
   `optimisticSubmit` as a prop. A form no longer has to live inside the island's
   body to be optimistic, which is what tied the Papelera to the board file.

3. **The board's vocabulary is one place.** `board-format.ts` decides a holding's
   magnitude, its money string, its rung colour and its ownership label;
   `board-sections.ts` projects groups into sections and composition segments.
   Two modules deciding a rung's colour on their own is how a debt ends up
   speaking the debe hue in one place and its rung's in another.

4. **Both halves of a concern live together.** The pure `optimistic-board.ts` and
   `board-fold.ts` moved into `_board/` alongside their React halves, so the
   board's vocabulary is one directory and not two.

5. **The pure seams carry the tests.** `board-sections`, `board-format` and
   `memberGradient` are pure and tested directly — the §7 split the board already
   made for the merge and the fold, extended to the projection.

## Consequences

- **Nothing on screen moves.** Same markup, same classes, same ARIA, same order.
  Pinned by the untouched board tests and, during the refactor, by a same-process
  parity harness rendering `main`'s board and the split one over five fixtures
  (portfolio open and collapsed, trash with an exit, closed positions, privacy,
  demo, no public ids, single section, empty) — byte-identical in all five.
- **`balance-board.tsx` is 258 lines.** It folds the model, splits it into two
  panes, reconciles the footer, and hands each part to the module that owns it.
- **A row change no longer opens the file that owns the reconciliation**, and the
  reverse.
- **The cost is prop drilling.** What the closure supplied implicitly is now
  passed explicitly — `Pane` takes eighteen props, `HoldingRow` fifteen. Deliberate
  for now: bundling them into a `BoardFormat` / `MutationContext` is a redesign of
  the interface, and this change is an extraction. When a third surface wants the
  same clump, that is the moment.
- **Grouping, ordering and totals stay in `@worthline/domain`.** `_board/` projects
  what the domain already grouped; it does not decide what belongs together.
