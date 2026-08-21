# A managed portfolio is a grouping entity, not a holding

- Status: accepted
- Date: 2026-08-21
- Issue: #1399

## Context

A roboadvisor portfolio (MyInvestor «Cartera Indexada Metal», Indexa, Finizens)
is something the owner knows as **one balance** but the app models as loose fund
holdings. The real damage is documented in #1399: a bridge fund carried 7.642 €
out of net worth when hard-deleted, the container's own cash (contributions
waiting for the investment threshold) has no representation, and the aggregate
figures the owner actually reads (total, invested, return) exist nowhere.

Two facts constrain the design:

1. **Flatness is an executable invariant, not a convention.**
   `assertSnapshotHoldingsReconcile` demands that snapshot holding rows sum
   *exactly* to the headline from 8 production call sites — including the
   re-assertion on workspace import. Every ripple, every historical
   recalculation, and the portfolio projection encode "one holding = one
   summand".
2. **The grouping shape already exists twice.** `goal_holdings` and
   `contribution_allowance_holdings` are N:M joins from an entity with figures
   of its own onto live holdings that keep summing untouched ("un conjunto, no
   un holding").

The member funds in the live fixture (Jorge's workspace) already reconcile
against the manager's app at NAV freshness — the positions are honest; only the
container is missing.

## Decision

A **managed portfolio** is a new entity plus a join table onto live holdings —
never an asset, never a parent in a holding hierarchy.

- **Members stay first-class.** Each fund keeps its own price, operations,
  snapshots, exposure, and keeps summing into net worth exactly as today. The
  net-worth engine, the snapshot tables, and the reconcile invariant are not
  touched.
- **Membership is exclusive** (unique index on the holding): a position lives
  physically inside one portfolio. This deliberately differs from goals and
  allowances, where overlap is a legitimate view — here overlap would be a data
  error. Sync-owned holdings (connected sources) cannot be members for now.
- **The portfolio's value is derived** (members + cash). The balance the owner
  reads in the manager's app is a **reconciliation witness**: latest declared
  value + date, stored on the entity; relative drift beyond 2 % raises a
  data-health signal. Never a plug row.
- **The container's cash is a sibling holding** — a normal `current_account`
  member auto-created at 0 € on registration. Valuation, snapshots, and health
  come for free; no parallel cash machinery on the entity.
- **Registering without enumerating is allowed**: the portfolio can be born
  with one aggregate "(sin detallar)" stored-valuation member equal to the
  declared balance, progressively replaced as composition is detailed. Net
  worth is honest from day one instead of under-counted.
- **No bridge-fund type.** The protection Groupama needed is a **generic trash
  gate**: sending any investment holding with value to the trash offers three
  exits — sold, transferred to… (a #1393 transfer pair), or mis-entry — so
  money never evaporates. A type is metadata the owner cannot know a priori.
- **The write path is unchanged.** Operations stay per holding; an internal
  rebalance is a #1393 transfer pair between members. A "contribution to the
  portfolio" operation with automatic split waits for a connector that knows
  the target weights.
- **In the portfolio list the portfolio wins over the grouping axes**: it
  always renders together as a collapsible group classified by its own
  aggregates (collapsed header = one summand; expanded children = breakdown,
  not extra summands), and links to its own ficha (composition, cash, witness).
- **Duplicate ISINs across live holdings are legitimate** (same fund at two
  brokers, or inside and outside a portfolio). No duplicate signal; membership
  is the natural disambiguator when a statement row's ISIN matches several
  live holdings.

## Considered options

- **Container as an asset whose value rules, members demoted to informative
  composition** — rejected. It needs a concept of "row that does not sum"
  replicated across the six historical recalculations, the seven ripples, the
  snapshot unique index, the projection invariant, and import/export. The only
  existing sub-detail that does not sum (`snapshot_position_holdings`, ADR
  0035) confirms the price: a separate table with its own sub-sum invariant,
  kept entirely outside the engine. It would also destroy member positions
  that already reconcile.
- **Generic holding nesting (`parent_id`)** — rejected: all of the above plus
  an open sum-vs-declared conflict at every level.
- **A cosmetic grouping label** — rejected: no cash, no witness, no aggregate
  figures, no protection; it answers none of #1399.
- **A bridge/transit holding type** — rejected in favour of the generic trash
  gate: the owner did not know Groupama was a bridge until told, so a type
  would never have been set on the row that needed it.

## Consequences

- The entity travels in workspace export/import and is exposed through
  agent-view/MCP (membership on holdings, the portfolio's own figures).
- The shape is deliberately the silhouette a future MyInvestor connector
  (#1000/#173) would populate: the portfolio moves from owner-typed to
  connector-fed without changing model.
- The portfolio's own return (the «+11,32 %» the owner sees) must come from
  the same returns engine as every other figure (witness discipline, ADR 0075
  spirit) — a later slice, never an ad-hoc formula in the ficha.
