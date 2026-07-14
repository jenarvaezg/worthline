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

/** Minimal provenance retained for one application of dated facts. */
export interface FactBatchInput {
  trigger: string;
  connectedSourceId?: string;
  syncRunId?: string;
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
