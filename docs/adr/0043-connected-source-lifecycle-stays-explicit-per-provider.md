# Connected-source lifecycle stays explicit per provider (supersedes ADR 0027)

## Context

[ADR 0027](0027-connected-source-adapter-lifecycle.md) introduced a `ConnectedSourceAdapter<Creds, Token>` interface, a tag→adapter registry (`packages/pricing/src/adapters/`), and a generic `connect/sync/disconnect` lifecycle module (`apps/web/app/ajustes/connected-source-lifecycle.ts`) so that a new connected source would be "implement the interface, register the tag." It was implemented and shipped.

The over-engineering audit (#577) measured the result against the reality that worthline has exactly **two** connected sources, Numista and Binance, and that their lifecycles **diverge more than they share**:

- Numista has `revalue` (budget/TTL-gated melt + numismatic refresh) and **no** history; Binance has `buildHistory` (monthly API-bounded curve) and **no** in-place revalue (its "revalue" is a full re-sync). The interface expresses this divergence as **nullable capabilities** (`revalue: (…) => … | null`, `buildHistory: (…) => … | null`) and the call sites carry the matching `?? re-sync` forks and non-null assertions.
- The machinery is ~783 lines (`types.ts` 202, `connected-source-lifecycle.ts` 322, `registry.ts` 47, plus the two adapter objects) standing in for what, at N=2, is a small explicit branch on a two-value union.

A closed-set adapter pays off at **N≥3** providers with a genuinely shared lifecycle. At **N=2** with divergent lifecycles it is speculative generality: it costs more indirection than the branching it removed. The "register the third source in one line" benefit is for a third source that does not exist and may never arrive (the broker statement path, ADR 0018, lands as a file import, not a live connected source).

## Decision

**Supersede ADR 0027.** Each connected source owns its `connect / sync / refresh / disconnect / freeze / history` behaviour **explicitly in its own provider module**. There is no shared `ConnectedSourceAdapter` interface, no registry, no nullable capability fields, and no non-null assertions standing in for provider-specific behaviour.

**Replacement rule** (what governs connected-source code going forward, and what #578 implements):

1. **Per-provider explicitness.** `numista-*` and `binance-*` modules hold their own full lifecycle. Provider-specific instrument / rung / valuation / history logic lives in that provider's code, not behind a polymorphic object.
2. **Leaf helpers stay shared.** Genuinely identical, provider-agnostic glue (`currentUrlOf` / `runWith` / `scopeMemberId`, `resolveConnectingOwnership`, `formatLastSync`) remains shared as plain functions. Sharing leaf utilities was never the cost — the cost was the adapter + registry + nullable-capability layer on top.
3. **Where the store needs the provider's instrument/suffix, branch explicitly on the persisted `adapter` tag** (a two-value union). A small explicit switch is cheaper here than the interface + registry + capability machinery it replaces.
4. **No capability-as-null.** Express "Binance has no revalue" / "Numista has no history" by the module simply not having that path — not by a nullable method on a shared contract that every call site must defend against.
5. **Re-introduce a shared abstraction only at the third source, with three real examples in hand** — never speculatively for the second. If a third connected source arrives and the lifecycle genuinely repeats, that is the moment to extract, and it gets its own ADR then.

## Considered options

- **Supersede; keep behaviour explicit per provider (chosen).** Removes the indirection whose cost the audit measured; behaviour is unchanged. Cost: a third source re-derives shared structure by reading the two existing modules — acceptable, and the honest trigger to abstract.
- **Keep ADR 0027 as accepted.** Rejected: it requires recording the concrete reason the abstraction earns its cost at only two providers (#577 criterion), and there isn't one — the nullable-capability shape is itself the evidence the two lifecycles don't share enough.
- **Narrow it (metadata in `@worthline/domain`, IO in pricing — ADR 0027's own fallback).** Rejected as a half-measure: it keeps the interface and registry (the bulk of the indirection and the nullable capabilities) while only relocating fields. The audit's finding is about the abstraction layer, not the dependency edge.

## Consequences

- **Supersedes ADR 0027.** ADR 0027 is marked superseded and stays in the log for history.
- **ADR 0016 is preserved**: positions stay sub-detail, the holding's value stays derived, ownership stays the one mutable field, disconnect keeps the remove/freeze fork. Only the indirection is removed; none of this behaviour changes.
- **ADR 0021 is preserved**: Binance live `balance × price`, per-rung holdings, and the monthly API-bounded frozen history stay exactly as they are, now expressed directly in the Binance module.
- **#578 is the implementation**: remove `packages/pricing/src/adapters/{types,registry}.ts` + the `ConnectedSourceAdapter` interface, collapse the generic `connected-source-lifecycle.ts` into the two providers' explicit flows, and drop the nullable-capability forks and non-null assertions. Connected-source persistence, action, pricing, and e2e/wiring tests must stay green.
- **The N=2 → N=3 boundary is now explicit policy**: the next connected source is the trigger to reconsider a shared lifecycle, not before.
- **The "no shared abstraction" rule is scoped to this live-valued lifecycle, and is no longer absolute**: [ADR 0066](0066-connector-ingestion-port-and-conformance-suite.md) introduces a *different* shared boundary — the connector **ingestion** port for fact-reconcile feeds (universal statement / IBKR / open banking / exchanges) — precisely because that catalogue is the ≥3-real-examples trigger this ADR set. Numista and Binance stay explicit-per-provider as decided here; they are not folded into that port.
