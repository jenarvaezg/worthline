/**
 * Connector ingestion port (PRD #1000 S2, decision #888, CONTEXT "Connector
 * ingestion port").
 *
 * The shared, staged boundary through which an external feed presents stable,
 * **normalized facts** for **preview → reconciliation → confirmation → atomic
 * application**. It covers both live connected sources and file-based statement
 * feeds without making their authentication, history, valuation, consent, or
 * disconnect lifecycles the same.
 *
 * This module is the PURE half of the port (`docs/interaction-patterns.md`): the
 * fact/capability/cursor vocabulary and the reconciliation step. It has no
 * network and no persistence. An adapter does its own I/O and returns pure
 * {@link NormalizedBatch}es; the application (not the adapter) owns authorization,
 * **deduplication**, the sync run, audit, and the atomic **commit** — that half
 * lives behind `applyDatedFactsBatch` in `@worthline/db` ({@link
 * ../../../db/src/commands/connector-commit}).
 *
 * It is a *different* abstraction from the per-provider connected-source
 * lifecycle of ADR 0043 (which stays explicit for the two live-valued,
 * position-mirroring sources, Numista and Binance): this port is the
 * fact-ingesting boundary the incoming connector catalogue (universal statement
 * → IBKR → open banking → exchanges) shares — the ≥3 real examples ADR 0043 said
 * must exist before a shared boundary earns its keep.
 */

/**
 * A stable, content-derived identity for one normalized fact — the **dedup key**.
 * Two fetches that re-observe the same underlying event (an overlapping window, a
 * retried sync) MUST derive the SAME key, so the application applies that fact
 * exactly once. The adapter mints it from the source's own stable identifiers
 * (a transaction id, an `externalId:date` pair), never from ingestion time.
 */
export type FactKey = string;

/**
 * An opaque, adapter-defined resumption token. The application persists the
 * cursor a successful commit advanced to and hands it back to the next fetch, so
 * the adapter resumes where it left off. Its shape is the adapter's private
 * concern; the port only carries it. `null` means "from the beginning".
 *
 * **Monotonicity contract.** Key-based reconciliation makes a fact that is
 * *fetched twice* safe, but it cannot rescue a fact that is never fetched. So an
 * adapter MUST NOT advance its cursor past an event it has not yet emitted: a
 * source that posts backdated or late-arriving events (open banking is the
 * canonical case) must either keep the cursor at a safe watermark until such
 * events settle, or deliberately re-serve an overlap window each fetch and let
 * {@link reconcileFacts} drop the repeats. A cursor that races ahead of
 * settlement silently loses the straggler — a gap no dedup or idempotency check
 * downstream can detect. A conformance harness for such a source must include a
 * backdated-event case to prove its overlap handling.
 */
export type ConnectorCursor = string;

/** The operations a connector can support, declared up front and discriminated by
 *  `kind` so the application never calls a path the connector does not implement.
 *  A connector reports the subset it supports (CONTEXT: "reports capabilities
 *  explicitly"); the list is the closed vocabulary of those kinds. */
export type ConnectorCapability =
  | { kind: "discover_accounts" }
  | { kind: "fetch_transactions" }
  | { kind: "fetch_positions" }
  | { kind: "fetch_balances" }
  | { kind: "disconnect" };

/** The discriminant of {@link ConnectorCapability}. */
export type ConnectorCapabilityKind = ConnectorCapability["kind"];

/** The three fetch capabilities — the ones that produce {@link NormalizedFact}s. */
export type FetchCapabilityKind = Extract<
  ConnectorCapabilityKind,
  "fetch_transactions" | "fetch_positions" | "fetch_balances"
>;

// Compile-time guard (type-only, no runtime cost): if a new `fetch_*` capability
// is ever added to ConnectorCapability without being listed in the Extract above,
// this alias resolves `Assert<false>` and fails to compile — the drift can't pass
// silently.
type Assert<T extends true> = T;
type _FetchKindsExhaustive = Assert<
  Extract<ConnectorCapabilityKind, `fetch_${string}`> extends FetchCapabilityKind
    ? true
    : false
>;

/**
 * One normalized fact an adapter emits — DB-agnostic and free of secrets. It is
 * the unit the port reconciles and the application commits.
 *
 * - `key` is the idempotency identity ({@link FactKey}).
 * - `dateKey` is the calendar date (`YYYY-MM-DD`) the fact lands on; it drives the
 *   ripple floor when the fact is committed (ADR 0012/0020).
 * - `payload` is opaque adapter data the application's own persister understands
 *   and maps to a dated-fact family; the port never inspects it.
 */
export interface NormalizedFact<TPayload = unknown> {
  key: FactKey;
  dateKey: string;
  payload: TPayload;
}

/**
 * What an adapter returns from one fetch: the facts observed in this window and
 * the cursor to resume from next time. A fetch that observed nothing new still
 * returns a (possibly advanced) cursor with an empty `facts` list — that is the
 * freshness signal (a sync happened; there was simply nothing to apply).
 */
export interface NormalizedBatch<TPayload = unknown> {
  facts: NormalizedFact<TPayload>[];
  cursor: ConnectorCursor | null;
}

/** An account a `discover_accounts` connector exposes for the user to link. */
export interface ConnectorAccount {
  /** The source's stable account identifier. */
  externalId: string;
  /** Human label for the link picker. */
  label: string;
}

/** A single fetch request: which fetch capability to run, resuming from `cursor`. */
export interface FetchRequest {
  capability: FetchCapabilityKind;
  cursor: ConnectorCursor | null;
}

/**
 * A connector adapter — the pure, I/O-owning half of the port. It authenticates
 * and talks to its source, and normalizes what it reads into a {@link
 * NormalizedBatch}. It NEVER touches the workspace database and never receives its
 * repositories (CONTEXT); the application drives it and commits the result.
 *
 * `id` replaces the closed `SourceAdapter` enum as the way a connector names
 * itself — an open string keyed by the catalogue, not a two-value union.
 * Capability-gated methods are optional; a caller checks {@link supportsCapability}
 * (or {@link assertCapability}) before invoking one.
 */
export interface ConnectorAdapter<TPayload = unknown> {
  readonly id: string;
  readonly capabilities: readonly ConnectorCapability[];
  /** Capability `discover_accounts`: list the accounts a credential exposes. */
  discoverAccounts?(): Promise<ConnectorAccount[]>;
  /** Capabilities `fetch_*`: fetch + normalize facts since `request.cursor`. */
  fetch(request: FetchRequest): Promise<NormalizedBatch<TPayload>>;
  /** Capability `disconnect`: tear down remote state on unlink. */
  disconnect?(): Promise<void>;
}

/** Whether an adapter declared support for a capability kind. */
export function supportsCapability(
  adapter: Pick<ConnectorAdapter, "capabilities">,
  kind: ConnectorCapabilityKind,
): boolean {
  return adapter.capabilities.some((capability) => capability.kind === kind);
}

/**
 * Assert an adapter declared a capability before the application invokes its
 * matching method. Throws a precise error otherwise — a connector must never run
 * a path it did not advertise (CONTEXT: capabilities are explicit).
 */
export function assertCapability(
  adapter: Pick<ConnectorAdapter, "id" | "capabilities">,
  kind: ConnectorCapabilityKind,
): void {
  if (!supportsCapability(adapter, kind)) {
    throw new Error(`Connector ${adapter.id} does not support capability "${kind}".`);
  }
}

/**
 * What reconciliation decided a fact is against what the source already applied.
 * `new` is applied on commit; `duplicate` was already seen (a prior sync or a
 * repeat within this batch) and is skipped. This is the minimum the idempotent
 * commit needs — the richer inbox dispositions a human triages (`modified` /
 * `dubious` / `skipped`) and the per-row actions + discard ledger live in the
 * reconciliation surface, {@link ../connector-inbox} (PRD #1000 S4, #890); only
 * that inbox's *visual* form is deferred (to the «Libro mayor» primitives, #825).
 */
export type FactDisposition = "new" | "duplicate";

/** One incoming fact tagged with what reconciliation decided about it. */
export interface ReconciledFact<TPayload = unknown> {
  fact: NormalizedFact<TPayload>;
  disposition: FactDisposition;
}

/**
 * The reconciliation plan for one fetched batch — the `preview` the surface paints
 * and the commit consumes. `reconciled` tags every incoming fact in input order;
 * `toApply` is just the `new` facts (dedup key first-seen), the ones a commit
 * persists. `cursor` is carried through unchanged from the fetch so the commit can
 * advance it atomically with the facts.
 */
export interface ReconcilePlan<TPayload = unknown> {
  reconciled: ReconciledFact<TPayload>[];
  toApply: NormalizedFact<TPayload>[];
  cursor: ConnectorCursor | null;
}

/**
 * Reconcile a fetched batch against the keys the source has ALREADY applied — the
 * pure `preview/reconcile` step (PRD #1000 S2). A fact whose key is in `seen`, or
 * that repeats an earlier fact's key within this same batch, is a `duplicate`;
 * everything else is `new`. Deduplicating within the batch as well as against
 * history is what makes an adapter that double-emits (an overlapping page) apply
 * each event once.
 *
 * Pure: reads `seen`, mutates nothing, and returns a fresh plan.
 */
export function reconcileFacts<TPayload>(
  batch: NormalizedBatch<TPayload>,
  seen: ReadonlySet<FactKey>,
): ReconcilePlan<TPayload> {
  const seenSoFar = new Set<FactKey>(seen);
  const reconciled: ReconciledFact<TPayload>[] = [];
  const toApply: NormalizedFact<TPayload>[] = [];

  for (const fact of batch.facts) {
    if (seenSoFar.has(fact.key)) {
      reconciled.push({ fact, disposition: "duplicate" });
      continue;
    }
    seenSoFar.add(fact.key);
    reconciled.push({ fact, disposition: "new" });
    toApply.push(fact);
  }

  return { reconciled, toApply, cursor: batch.cursor };
}
