/**
 * Shared command-layer types (architecture review jul 2026, #966).
 *
 * One application mutation = one UnitOfWork transaction + one RipplePlan +
 * one typed CommandResult. Vertical tracers (housing, debt, investment) build
 * on these primitives; server actions become parse-and-delegate.
 */

/** Typed success / failure for every command executor. */
export type CommandResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string };

/**
 * The ripple window a dated-fact command commits to. Derived behind the
 * command from the persisted facts — never supplied by the action layer.
 */
export interface RipplePlan {
  fromDateKey: string;
  today: string;
}

/**
 * What one debt ripple did, in snapshots (#1438). `generated` counts fresh
 * whole-portfolio snapshots built; `generatedWithLiability` those that carry
 * the triggering liability's row; `recalculated` the frozen ones whose row was
 * re-derived. The confirm message reads its N and M from here — never from the
 * number of re-baselines, which says nothing about what got written.
 */
export interface DebtRippleCounts {
  generated: number;
  generatedWithLiability: number;
  recalculated: number;
}

export const EMPTY_DEBT_RIPPLE_COUNTS: DebtRippleCounts = {
  generated: 0,
  generatedWithLiability: 0,
  recalculated: 0,
};

/** Closed vocabulary for the application paths that can originate dated facts. */
export type FactBatchTrigger =
  | "manual"
  | "csv"
  | "statement"
  | "sync"
  | "connect"
  | "cron"
  | "assistant";

/** Minimal provenance retained for one application of dated facts. */
export interface FactBatchInput {
  trigger: FactBatchTrigger;
  connectedSourceId?: string;
}

/**
 * Brackets a command's persist + ripple in the store's existing transaction
 * seam (`StoreContext.transaction`).
 */
export interface UnitOfWork {
  /** Persist one provenance row inside the same transaction as its facts. */
  createFactBatch(input: FactBatchInput): Promise<string>;
  transaction<T>(work: () => T | Promise<T>): Promise<T>;
}
