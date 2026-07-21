/**
 * Reconciliation inbox — the connector port's user-facing `reconcile` surface
 * (PRD #1000 S4, decision #890).
 *
 * The port's own {@link reconcileFacts} carries the minimum an idempotent commit
 * needs: `new` vs `duplicate`. This module elevates that into the four
 * dispositions a human triages before applying — **new / modified / dubious /
 * skipped** — and models the per-row actions (**accept / edit / ignore-once /
 * ignore-always**) and the persistent discard ledger ("remember-dismissed",
 * stolen from Sure's `rejected_transfers`) that an ignore-always writes so the
 * fact never resurfaces.
 *
 * It is PURE (`docs/interaction-patterns.md`): classification reads the applied
 * dedup ledger (`seen`), the discard ledger (`rejected`), and adapter-supplied
 * identity/ambiguity semantics; it mutates nothing. The atomic application of a
 * resolved decision — the facts AND the newly-rejected keys, committed together —
 * lives behind `commitReconciled` in `@worthline/db`. The *visual* form of this
 * inbox is deferred to the «Libro mayor» primitives (#825); this module is its
 * contract, proven end-to-end over the universal statement adapter.
 */

import type {
  ConnectorCursor,
  FactKey,
  NormalizedBatch,
  NormalizedFact,
} from "./connector-port";

/**
 * What triage decided one incoming fact is, before the user acts on it:
 * - `new` — an unseen fact with no prior counterpart; apply it;
 * - `modified` — the same underlying operation as an applied fact (same
 *   {@link InboxReconcileInput.identityOf identity}) but restated with different
 *   content (a corrected price/units); the row shows what it supersedes;
 * - `dubious` — parseable but ambiguous (e.g. an instrument with no ISIN that
 *   cannot be confidently matched); needs a human before it applies;
 * - `skipped` — suppressed: either already applied (a `duplicate`) or previously
 *   dismissed (`rejected`). Inert; carried only so the surface can show it.
 */
export type InboxDisposition = "new" | "modified" | "dubious" | "skipped";

/** Why a {@link InboxDisposition} of `skipped` is suppressed. */
export type SkipReason = "duplicate" | "rejected";

/**
 * A per-row action the user takes in the inbox:
 * - `accept` — apply the fact as-is;
 * - `edit` — apply a corrected replacement fact ({@link InboxDecisionInput.edits});
 * - `ignore_once` — drop it from this batch; it may reappear on a later sync;
 * - `ignore_always` — drop it AND remember its key so future syncs suppress it.
 */
export type InboxRowAction = "accept" | "edit" | "ignore_once" | "ignore_always";

/** The action the surface pre-selects for a freshly-classified row. */
const DEFAULT_ACTION: Record<InboxDisposition, InboxRowAction> = {
  new: "accept",
  // A restatement corrects an applied fact, but SUPERSEDING it (dropping the prior
  // fact) is the merge deferred to the live-surface refactor (#825). Until then,
  // auto-accepting would append a second, contradictory fact for one operation — a
  // double-count. So `modified` surfaces for review but applies nothing by default;
  // the user (or the later merge) decides. Accepting one today appends, knowingly.
  modified: "ignore_once",
  // Ambiguous: surface it, apply nothing until a human confirms.
  dubious: "ignore_once",
  // Inert: neither applied nor remembered by default.
  skipped: "ignore_once",
};

/** One incoming fact tagged with what triage decided and how to act on it. */
export interface InboxRow<TPayload = unknown> {
  fact: NormalizedFact<TPayload>;
  disposition: InboxDisposition;
  /** Present only when `disposition` is `skipped`. */
  reason?: SkipReason;
  /** Present only when `disposition` is `modified`: the applied key it restates. */
  supersedes?: FactKey;
  /** The action pre-selected for this row (the user may override it). */
  defaultAction: InboxRowAction;
}

/** Inputs to {@link reconcileInbox}. `seen`/`rejected` are the two ledgers the
 *  application persists; `identityOf`/`appliedIdentities`/`isDubious` inject the
 *  adapter's own semantics (a statement's are in `connector-statement-normalize`). */
export interface InboxReconcileInput<TPayload = unknown> {
  batch: NormalizedBatch<TPayload>;
  /** Content dedup keys already applied by this source (drives `duplicate`). */
  seen: ReadonlySet<FactKey>;
  /** Keys permanently dismissed via ignore-always (drives `rejected`). */
  rejected?: ReadonlySet<FactKey>;
  /** Stable identity of a fact — two facts with the same identity are the same
   *  underlying operation. Omit to disable `modified` detection. */
  identityOf?: (fact: NormalizedFact<TPayload>) => string;
  /** Identity → the content key already applied for it (drives `modified`). */
  appliedIdentities?: ReadonlyMap<string, FactKey>;
  /** Marks a fact ambiguous → `dubious`. Omit to disable dubious detection. */
  isDubious?: (fact: NormalizedFact<TPayload>) => boolean;
}

/** The classified inbox for one fetched batch — the `preview` the surface paints. */
export interface InboxPlan<TPayload = unknown> {
  rows: InboxRow<TPayload>[];
  /** Tally by disposition — the inbox header ("3 nuevos · 1 dudoso · …"). */
  counts: Record<InboxDisposition, number>;
  /** Carried through unchanged so the commit advances it atomically. */
  cursor: ConnectorCursor | null;
}

/**
 * Classify a fetched batch into the four inbox dispositions — the pure
 * `preview/reconcile` step (PRD #1000 S4). Precedence per fact, in batch order:
 *
 * 1. key in `rejected` → `skipped` (`rejected`) — a dismissal always wins, so a
 *    remembered discard never resurfaces however else it might classify;
 * 2. key in `seen`, or repeated earlier in this batch → `skipped` (`duplicate`);
 * 3. `isDubious` → `dubious` — ambiguity outranks a shaky identity match;
 * 4. identity applied under a *different* content key → `modified`;
 * 5. otherwise → `new`.
 *
 * Pure: reads the ledgers, mutates nothing, returns a fresh plan.
 */
export function reconcileInbox<TPayload>(
  input: InboxReconcileInput<TPayload>,
): InboxPlan<TPayload> {
  const rejected = input.rejected ?? new Set<FactKey>();
  const seenSoFar = new Set<FactKey>(input.seen);
  const rows: InboxRow<TPayload>[] = [];
  const counts: Record<InboxDisposition, number> = {
    new: 0,
    modified: 0,
    dubious: 0,
    skipped: 0,
  };

  for (const fact of input.batch.facts) {
    let row: InboxRow<TPayload>;

    if (rejected.has(fact.key)) {
      row = {
        fact,
        disposition: "skipped",
        reason: "rejected",
        defaultAction: DEFAULT_ACTION.skipped,
      };
    } else if (seenSoFar.has(fact.key)) {
      row = {
        fact,
        disposition: "skipped",
        reason: "duplicate",
        defaultAction: DEFAULT_ACTION.skipped,
      };
    } else {
      seenSoFar.add(fact.key);
      const identity = input.identityOf?.(fact);
      const priorKey =
        identity === undefined ? undefined : input.appliedIdentities?.get(identity);

      if (input.isDubious?.(fact)) {
        row = { fact, disposition: "dubious", defaultAction: DEFAULT_ACTION.dubious };
      } else if (priorKey !== undefined && priorKey !== fact.key) {
        row = {
          fact,
          disposition: "modified",
          supersedes: priorKey,
          defaultAction: DEFAULT_ACTION.modified,
        };
      } else {
        row = { fact, disposition: "new", defaultAction: DEFAULT_ACTION.new };
      }
    }

    counts[row.disposition] += 1;
    rows.push(row);
  }

  return { rows, counts, cursor: input.batch.cursor };
}

/** Inputs to {@link resolveInbox}: the classified plan plus the user's overrides. */
export interface InboxDecisionInput<TPayload = unknown> {
  plan: InboxPlan<TPayload>;
  /** Per-key action overriding the row's `defaultAction`. */
  actions?: ReadonlyMap<FactKey, InboxRowAction>;
  /** Per-key replacement fact for `edit` actions (a corrected row). */
  edits?: ReadonlyMap<FactKey, NormalizedFact<TPayload>>;
}

/** The outcome of resolving an inbox — what the commit persists. */
export interface InboxDecision<TPayload = unknown> {
  /** Facts to apply (accepted as-is or as an edited replacement), in row order. */
  toApply: NormalizedFact<TPayload>[];
  /** Keys to append to the discard ledger (ignore-always). */
  toReject: FactKey[];
  cursor: ConnectorCursor | null;
}

/**
 * Resolve a classified inbox against the user's per-row actions into the two
 * lists a commit needs: the facts `toApply` and the keys `toReject`. Pure.
 *
 * Each incoming key is decided EXACTLY ONCE — by its first row — so a within-batch
 * duplicate can never be applied twice even if forced to `accept`; the second
 * occurrence (already `skipped`) is dropped. `ignore_once` drops without
 * remembering; `ignore_always` drops and remembers. `edit` requires a replacement
 * in `edits` and throws otherwise, so a mis-wired edit fails loudly instead of
 * silently discarding the row.
 */
export function resolveInbox<TPayload>(
  input: InboxDecisionInput<TPayload>,
): InboxDecision<TPayload> {
  const toApply: NormalizedFact<TPayload>[] = [];
  const toReject: FactKey[] = [];
  const decided = new Set<FactKey>();

  for (const row of input.plan.rows) {
    if (decided.has(row.fact.key)) continue;
    decided.add(row.fact.key);

    const action = input.actions?.get(row.fact.key) ?? row.defaultAction;
    switch (action) {
      case "accept":
        toApply.push(row.fact);
        break;
      case "edit": {
        const replacement = input.edits?.get(row.fact.key);
        if (replacement === undefined) {
          throw new Error(
            `Inbox edit action for "${row.fact.key}" has no replacement fact.`,
          );
        }
        toApply.push(replacement);
        break;
      }
      case "ignore_once":
        break;
      case "ignore_always":
        toReject.push(row.fact.key);
        break;
    }
  }

  return { toApply, toReject, cursor: input.plan.cursor };
}
