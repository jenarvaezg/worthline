# A proposal is parsed into its contract, never asserted into it

## Context

A `propose_*` tool answers on the server and its output reaches the card as
`unknown`: it crossed the model stream, and the browser holding it may have loaded
the app before the deploy that changed the shape. `proposal-card-presence.ts` (ADR
0088) is where that answer becomes a card — a `parse*Proposal` per lane, twelve of
them, each one a trust boundary.

Every one of them ended the same way:

```ts
if (draft === null || typeof raw.folio !== "string" || !isRecord(raw.impact)) {
  return null;
}
return raw as unknown as HoldingCreationProposal;
```

A handful of fields checked, and then a promise about all the rest. The promise was
not kept, and the gap was not theoretical:

- `parseCorrectionProposal` checked `Array.isArray(raw.series)` and nothing about
  the points inside it, then returned a value typed as carrying
  `CorrectionSeriesPoint[]`.
- `parseHoldingCreationProposal` accepted any string as the `family` — a value the
  card switches on.
- `parseOperationProposal` never looked at `kind` at all.
- `parseHoldingTrashProposal` accepted three bare `Array.isArray` calls as the whole
  batch the card renders and sums.
- The reconstruction contract declared `snapshotMembership` as required while no
  parser checked it, so the cards read it defensively as `| undefined` — the type
  said one thing and every reader assumed another.

The failure mode this creates is the one the cast hides: a payload missing a field
the card DEREFERENCES passes the typechecker and throws while painting, inside the
assistant layer. #1422 fixed exactly that for one field (`reconciliation.anchor`) by
adding one more hand-written check — evidence that the shape of the problem was
already known, and that adding checks one at a time does not close it.

## Decision

**No parser asserts. Each one BUILDS the domain value out of checked parts, or
returns `null`.**

1. **The kind closes the type.** `parse*Proposal` reads the discriminant, then
   parses every field the contract names — arrays element by element, unions branch
   by branch — and returns an object literal. Because the value is *constructed*,
   the compiler is what checks that the contract is complete: a field left out is a
   build error, not a runtime surprise. There is no `as unknown as` on the
   production path.

2. **One module per family, over shared primitives.** The twelve parsers moved out
   of `assistant-actions.ts` (870 → 332 lines, which is again what it claims to be:
   quick actions and destinations) into `asistente/proposal-parsers/`, one file per
   lane beside a `shapes.ts` of primitives — `parseAll`, `parseOptional`,
   `parseNetWorthImpact`, `parseBalanceReconciliation`, `parseFundPreviewRow`. It is
   the same registry shape as ADR 0086's tools and ADR 0088's cards: a new lane is a
   module and a row, never a block appended to a file nobody can read.

3. **A refusal is a card that is absent, never a crash.** Rejecting returns `null`,
   which `proposal-card-presence.ts` already means as «no card» — and the guard of
   #1468 reads the same answer, so the ceremony warning cannot disagree with the
   render. The persisted draft is untouched: the next turn rebuilds the card.

4. **Hand-written parsers, not a schema library.** Zod is already a dependency and
   was tried first: under `exactOptionalPropertyTypes` its inferred
   `{ a?: string | undefined }` is not assignable to a contract's `{ a?: string }`,
   so every optional field would need a cast — which is the thing being removed. The
   primitives spell an optional as a conditional spread instead, and the absent key
   stays absent.

5. **Where a parser is stricter than before, it is stricter about a field the card
   renders.** `snapshotMembership` is the sharpest case: the contract declared it
   required, no parser checked it, and `snapshotMembershipAllowsConfirm(undefined)`
   answers **true** — so an absent membership was the #1438 confirm gate opening on
   a figure nobody measured. It stays required and is now checked; a payload without
   it loses its card, which is the honest half of that pair.

6. **A vocabulary is never a hand-written list.** `isOneOf` reads from the union's
   own members: `INSTRUMENTS` is now exported from the instrument catalog (derived
   from its exhaustive defaults map, like `INVESTMENT_PRICE_PROVIDERS`), fidelity
   tiers and movement kinds come from their own modules, and the rest are built with
   `vocabulary<T>({…})` — a `Record` over the union, so a member added tomorrow fails
   to compile instead of leaving a list one value short. A short list at a trust
   boundary is not a lint nit: it is a card that quietly stops being painted (#1329).

## Consequences

- A malformed payload loses its card at the boundary and the panel keeps working.
  A stale tab across a deploy is the ordinary case, and it degrades the way the
  contracts already documented: no card, draft intact, next turn rebuilds it.
- The fixtures moved with the parsers (`proposal-parsers/fixtures.ts`): one real
  payload per kind, in one place. A fixture that omits a rendered field is the same
  lie the casts were, one layer up — the table-driven test asserts each kind parses,
  paints through its registered lane, refuses the stale payload, and drops a field
  nobody declared.
- Two test fixtures were found to be lying and were corrected, which is the change
  paying for itself: `assistant-layer-repeated-summary.test.tsx` built an alta with
  `family: "fund"` (not one of the four) and `duplicate: null` (the builder omits the
  key), and the old correction tests asserted on a `{ state: "reconciled" }`
  guarantee with no figures — a card that would have printed «undefined €».
- Widening a contract now costs a parser edit. That is the intended price: a field
  added to a `*Proposal` interface with no parser to read it does not compile.
