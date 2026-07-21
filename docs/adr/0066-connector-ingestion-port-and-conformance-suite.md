# Connector ingestion port + conformance suite

## Context

worthline links to external feeds — first the two live-valued connected sources
(Numista, Binance), and next a catalogue of **fact-ingesting** feeds: a universal
broker statement, IBKR, European open banking, and exchanges. The decision map
[#888](https://github.com/jenarvaezg/worthline/issues/888) (compiled into PRD
[#1000](https://github.com/jenarvaezg/worthline/issues/1000)) asked whether these
new feeds should each grow their own model + routes + dedup logic — the path Sure
took, where its per-provider generator drifted out of alignment
([sure#2546](https://github.com/we-promise/sure/issues/2546)) — or share one
narrow boundary.

[ADR 0043](0043-connected-source-lifecycle-stays-explicit-per-provider.md)
deliberately keeps the two live-valued sources' lifecycles explicit per provider
and forbids re-introducing a shared abstraction "until a third source arrives with
three real examples in hand." The incoming fact-ingesting catalogue is exactly
that: three-plus real examples of the *same* flow — pull dated facts, preview
them, let the user reconcile, then apply atomically.

The command layer this port applies through already exists (PRD
[#997](https://github.com/jenarvaezg/worthline/issues/997), ADR
[0062](0062-dated-facts-enter-through-commands-with-batch-provenance.md)):
`ApplyDatedFactsBatch` gives one application = one `fact_batch` + one transaction
+ one ripple, and `fact_batch` already carries a `connectedSourceId`.

## Decision

Formalize **one connector ingestion port** for fact-ingesting feeds — the staged
boundary `normalized facts → preview/reconcile → confirm/apply` — with a **common
conformance suite** and a **reference in-memory adapter**. This is PRD #1000 S2.

### The port is staged and the adapter is pure

1. **normalize** — an adapter authenticates, talks to its source, and normalizes
   what it reads into `NormalizedFact`s (a dedup `key`, a calendar `dateKey`, an
   opaque `payload`) plus a resumption `cursor`. The adapter does its own I/O and
   **never touches the workspace database or receives its repositories**.
2. **preview / reconcile** — `reconcileFacts(batch, seen)` (pure, in
   `@worthline/domain`) tags each incoming fact `new` or `duplicate` against the
   dedup ledger, deduplicating within the batch as well, and yields the facts to
   apply. The richer inbox dispositions (`modified` / `dubious` / `skipped`) are
   the reconciliation *surface*'s job (S4, #890) and are deferred with its visual
   form.
3. **confirm / apply** — `commitReconciled` (in `@worthline/db`) routes the `new`
   facts through `ApplyDatedFactsBatch`: one commit is exactly one `fact_batch`,
   one transaction, and at most one ripple. The cursor and dedup-ledger advance
   run **inside that same transaction** (a new `afterPersist` hook on the batch
   executor), so facts and cursor commit or roll back together.

### Capabilities are declared and discriminated

A connector declares its `capabilities` as a discriminated union
(`discover_accounts`, `fetch_transactions`, `fetch_positions`, `fetch_balances`,
`disconnect`). The application checks a capability before invoking its method
(`assertCapability`); a connector never runs a path it did not advertise. An
adapter's `id` is an open string keyed by the catalogue — it **replaces the closed
`SourceAdapter` enum as the way a connector names itself** for this class of feed.

### Idempotency is a two-part guarantee

- Reconciliation drops keys already in the dedup ledger, so a re-served overlapping
  window applies nothing;
- the cursor + ledger advance is atomic with the facts, so a commit that fails
  part-way rolls both back, and a retry re-reconciles against the unchanged ledger
  and applies each fact exactly once.

A no-op sync (nothing new) still opens a batch and advances the cursor — freshness
without a rewrite.

### The conformance suite is common

`describeConnectorConformance` is the single battery every connector passes —
**idempotency, duplicates, retries, freshness, unlink, atomicity** — run against a
faithful in-memory application host (rollback-on-throw `UnitOfWork`, fact ledger,
dedup ledger, cursor, ripple log) that drives the *real* `reconcileFacts` +
`commitReconciled`. A new adapter earns its correctness by wiring a fake and
calling the suite, not by re-litigating these invariants per provider. It runs
green against the reference in-memory adapter as the acceptance proof.

### Catalogue priority

Adapters land in this order (robust universal import first, exchanges last):

**universal statement → IBKR → open banking → exchanges.**

## Relationship to ADR 0043 (does not resurrect ADR 0027)

This port does **not** reopen ADR 0027's per-provider adapter registry, and it does
**not** put Numista and Binance behind a shared object. Those two remain
explicit-per-provider exactly as ADR 0043 decided: they are live-valued,
position-mirroring sources whose divergent authentication / history / valuation /
disconnect lifecycles do not fit a fact-reconcile flow. This is a *different*
abstraction — the fact-ingesting boundary — introduced now precisely because the
condition ADR 0043 set has been met: three-plus real examples of one genuinely
shared flow. If and when a live-valued source is re-expressed as a fact feed, it
adopts this port; until then the two live sources are untouched.

## Considered options

- **One shared port for the fact-ingesting catalogue (chosen).** Pays for itself at
  ≥3 real examples; the conformance suite is what keeps adapters from drifting.
- **Per-provider model + routes + dedup (Sure's path).** Rejected: it is the
  drift #2546 documents, and #888 exists to avoid it.
- **Fold the live sources (Numista/Binance) into the port now.** Rejected: their
  lifecycles diverge (ADR 0043); forcing them in re-introduces the nullable-
  capability shape ADR 0043 removed.

## Consequences

- `@worthline/domain` gains the pure port vocabulary (`connector-port.ts`) and the
  reference adapter; `@worthline/db` gains `commitReconciled` and the common
  conformance suite. `ApplyDatedFactsBatch` gains an optional in-transaction
  `afterPersist` hook (backward-compatible; existing callers unaffected).
- ADR 0062's "one batch = one transaction + one ripple" and ADR 0020's atomicity
  remain authoritative; this port is a caller of them, not a new mutation surface.
- Later slices add adapters (S3 universal statement, then IBKR / open banking /
  exchanges) and the reconciliation inbox surface (S4); each new adapter must pass
  the conformance suite.
- **S4 reconciliation inbox (#1068) lands the surface's contract**
  (`connector-inbox.ts`): the four triage dispositions (`new` / `modified` /
  `dubious` / `skipped`), the per-row actions (`accept` / `edit` / `ignore-once` /
  `ignore-always`), and the persistent discard ledger — an ignore-always key is
  recorded via `recordCommit`'s new `rejectedKeys`, atomic with the facts and
  cursor, so a dismissal never resurfaces. `FactDisposition` stays the minimal
  `new`/`duplicate` the commit needs; the inbox is the richer read on top. Only
  the inbox's *visual* form is deferred (to «Libro mayor» primitives, #825).

## Deliberately deferred / revisit later

- **A no-op sync still writes one empty `fact_batch`.** This is an audit record —
  "a sync ran against source X and applied nothing" — which the application owns
  (CONTEXT). On a poll loop (two crons/day) these accumulate. Accepted for now as
  cheap, honest provenance; revisit with a retention/prune story, or move pure
  freshness onto a `lastSyncedAt` on the connected source, when volume warrants.
- **Cursor monotonicity is an adapter contract, not a port guarantee.** The port
  cannot enforce that an adapter's cursor never races past an un-emitted backdated
  fact (the open-banking hazard). It is documented on `ConnectorCursor`, and each
  such adapter's conformance harness must add a backdated-event case; the reference
  adapter's clean sequence cursor does not exercise it.
