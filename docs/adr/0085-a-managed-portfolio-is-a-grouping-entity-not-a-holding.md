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
  data-health signal. Never a plug row. **The careo excludes the container's
  cash** — see the amendment below.
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
  Implemented in #1549 at the store seam (`softDeleteAsset`), not in the Server
  Action, so the assistant's baja meets the same refusal. Only `mis_entry`
  unlocks a live position; the other two name a movement already written.
- **The container's cash cannot be trashed while the portfolio lives** (#1549).
  It is the only member the owner did not create — the alta did — and its
  balance is real money (up to 150 € + 0,5 % of the portfolio waiting to be
  invested), so a silent delete would be the Groupama shape under another
  instrument label. Offering it the three exits was the alternative and was
  rejected: none of them describes what happened to a casilla of a container
  ("lo saqué a mi cuenta" is a movement the app cannot yet record as a pair
  between a cash account and a fund). Dissolving the portfolio releases it as an
  ordinary account — dissolving a group never deletes money — and from there it
  is archivable like any other.
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

## Amendment (2026-08-23, #1550): the witness is careed against the funds, not the total

The 21-08 screenshots of the real Metal, cross-read against the live book, showed
that the balance the owner reads is the sum of the SEVEN FUNDS, not the container:

```
suma de los 7 fondos      = 1.497,36 €
«Valor de mercado» app    = 1.497,37 €   ← la misma cifra
invertido 1.345,12 + plusvalía 152,25 = 1.497,37
efectivo, casilla aparte  =     7,34 €
total real del contenedor = 1.504,71 €
```

The original decision above assumed the declared balance was the whole container
(funds + cash). It is not, and the difference is not cosmetic: worthline's derived
total DOES include the cash sibling, so careing the two would compare different
things — exactly what the witness discipline forbids (#1422). Worse, the bias is
not constant: the cash accumulates up to `150 € + 0,5 %` of the portfolio before
being invested (the manager's own prompt confirms the rule: 150 + 0,5 % ×
1.497,37 = 157,49, and with 7,34 € in the box it says «te faltan 151 €»). On a
~1.500 € portfolio that is more than ten points of drift generated BY DESIGN,
right before every contribution — the 2 % signal would fire monthly with nothing
wrong.

Therefore: **the witness is careed against the investment members only**, and the
container's cash is reported beside it, the way the manager's app reports it. The
owner types the number they see, adding nothing by hand — the alternative
(asking for the total WITH cash) makes them do the arithmetic this app exists to
remove. The same correction applies to the portfolio's own return (S6, #1552):
it is measured on the funds, not on the cash.

A member with no honest value in the base currency silences the careo instead of
comparing a short sum against the manager's full one (#1401's shape), and a
member that is no longer live is skipped — it contributes nothing to the derived
total the ficha prints either. The careo reads UNCONVERTED money for the same
reason the two surfaces share one engine: the data-health signal has no FX layer,
so a ficha careing converted figures would claim a drift the signal cannot see
(#1422's shape). The cash box is the `cash` member and only it — a stored-valuation
member that is not cash (the "(sin detallar)" aggregate above) is invested money
and belongs inside the careo — and that rule lives in one domain builder so no
surface re-derives it.

## Consequences

- The entity travels in workspace export/import and is exposed through
  agent-view/MCP (membership on holdings, the portfolio's own figures).
- The shape is deliberately the silhouette a future MyInvestor connector
  (#1000/#173) would populate: the portfolio moves from owner-typed to
  connector-fed without changing model.
- The portfolio's own return (the «+11,32 %» the owner sees) must come from
  the same returns engine as every other figure (witness discipline, ADR 0075
  spirit) — a later slice, never an ad-hoc formula in the ficha.
