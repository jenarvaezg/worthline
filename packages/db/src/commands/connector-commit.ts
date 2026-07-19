import type {
  ConnectorCursor,
  FactKey,
  NormalizedFact,
  ReconcilePlan,
} from "@worthline/domain";

import { applyDatedFactsBatch } from "./apply-dated-facts-batch";
import type { CommandResult, FactBatchTrigger, RipplePlan, UnitOfWork } from "./types";

/**
 * The connector state the application persists between syncs — the two things a
 * commit reads to stay idempotent and advances when it succeeds (decision #888):
 * the dedup `seen` ledger (which fact keys the source already applied) and the
 * resumption `cursor`. Reconciliation reads `seen`; the commit advances both.
 */
export interface ConnectorCommitState {
  seen: ReadonlySet<FactKey>;
  cursor: ConnectorCursor | null;
}

/** The bookkeeping a successful commit records, inside the fact transaction. */
export interface ConnectorCommitRecord {
  batchId: string;
  cursor: ConnectorCursor | null;
  /** The keys applied in this batch — appended to the dedup ledger. */
  appliedKeys: FactKey[];
}

export interface ConnectorCommitParams<TPayload> {
  /** The reconciled batch: only its `toApply` facts are persisted. */
  plan: ReconcilePlan<TPayload>;
  today: string;
  /** Provenance: the connected source this application belongs to. */
  connectedSourceId: string;
  /** Ingestion origin recorded on the fact batch; defaults to `sync`. */
  trigger?: Extract<FactBatchTrigger, "sync" | "connect" | "statement" | "csv">;
  /**
   * Persist ONE normalized fact as a dated fact, tagged with `batchId`. The
   * application owns this DB wiring (maps the opaque payload to a fact family);
   * the adapter never sees it. The fact's `dateKey` drives the ripple floor.
   */
  persistFact: (fact: NormalizedFact<TPayload>, batchId: string) => Promise<void>;
  /** Re-derive snapshots from the earliest applied date (ADR 0020). */
  ripple: (fromDateKey: string) => Promise<void>;
  /**
   * Advance the cursor and dedup ledger. Runs inside the SAME transaction as the
   * facts (via `applyDatedFactsBatch`'s `afterPersist`), so cursor and facts
   * commit or roll back together — the atomicity the conformance suite proves.
   */
  recordCommit: (record: ConnectorCommitRecord) => Promise<void>;
  uow: UnitOfWork;
}

export interface ConnectorCommitResult {
  /** How many facts this commit persisted (0 for an all-duplicate / empty sync). */
  applied: number;
  /** The cursor the source resumes from next time. */
  cursor: ConnectorCursor | null;
  /** The ripple window, or null when nothing datable-in-the-past was applied. */
  ripple: RipplePlan | null;
}

/**
 * Commit a reconciled batch — the port's `confirm/apply`, atomic application
 * (PRD #1000 S2, CONTEXT "Connector ingestion port"). It routes through
 * `applyDatedFactsBatch`, so one commit is exactly ONE `fact_batch`, ONE
 * transaction, and at most ONE ripple (ADR 0062). Every `toApply` fact becomes a
 * dated-fact step; the cursor and dedup-ledger advance run in the same
 * transaction via `afterPersist`.
 *
 * Idempotency is a two-part guarantee:
 * - {@link reconcileFacts} already dropped keys in `seen`, so a re-sync of an
 *   overlapping window has an empty `toApply` and persists nothing;
 * - the cursor + ledger advance is atomic with the facts, so a commit that fails
 *   part-way rolls BOTH back — a retry re-reconciles against the unchanged ledger
 *   and applies each fact exactly once.
 *
 * An empty `toApply` (all duplicates, or a no-op sync) still opens a batch and
 * runs `recordCommit`, advancing the cursor: freshness without a rewrite.
 */
export async function commitReconciled<TPayload>(
  params: ConnectorCommitParams<TPayload>,
): Promise<CommandResult<ConnectorCommitResult>> {
  const { plan } = params;
  const appliedKeys = plan.toApply.map((fact) => fact.key);

  const result = await applyDatedFactsBatch(params.uow, {
    batch: {
      trigger: params.trigger ?? "sync",
      connectedSourceId: params.connectedSourceId,
    },
    today: params.today,
    steps: plan.toApply.map((fact) => ({
      persist: async (batchId) => {
        await params.persistFact(fact, batchId);
        return fact.dateKey;
      },
    })),
    afterPersist: async (batchId) => {
      await params.recordCommit({ batchId, cursor: plan.cursor, appliedKeys });
    },
    ripple: params.ripple,
  });

  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    value: {
      applied: appliedKeys.length,
      cursor: plan.cursor,
      ripple: result.value,
    },
  };
}
