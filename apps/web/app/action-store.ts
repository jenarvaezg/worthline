import { type WorthlineStore, withStore } from "@web/store";

/**
 * The shared `_store?` action seam (issue #481).
 *
 * Server actions accept an optional `_store` so integration tests can run them
 * against an in-memory store; in production it is absent and a real `withStore`
 * transaction is opened — which resolves the demo / authenticated / local target
 * (ADR 0030) and closes the store after `fn` settles. This is the ONE place that
 * branch lives, replacing the per-action `runWith` closures that each
 * re-implemented `_store ? fn(_store) : withStore(fn)`.
 *
 * An injected store is NOT closed here: the test that created it owns its
 * lifecycle. `Promise.resolve` unifies sync and async `fn` returns, so both the
 * `(store) => T` and `(store) => Promise<T>` call shapes work unchanged.
 */
export function runActionWithStore<T>(
  fn: (store: WorthlineStore) => T | Promise<T>,
  injectedStore?: WorthlineStore,
): Promise<T> {
  return injectedStore ? Promise.resolve(fn(injectedStore)) : withStore(fn);
}

export function testStoreFromActionArgs(
  args: IArguments | readonly unknown[],
): WorthlineStore | undefined {
  return testArgFromActionArgs(args, isWorthlineStoreLike);
}

export function testArgFromActionArgs<T>(
  args: IArguments | readonly unknown[],
  predicate: (value: unknown) => value is T,
): T | undefined {
  if (!isTestRuntime()) {
    return undefined;
  }

  for (const value of Array.from(args)) {
    if (predicate(value)) {
      return value;
    }
  }

  return undefined;
}

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function isWorthlineStoreLike(value: unknown): value is WorthlineStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "workspace" in value &&
    "assets" in value &&
    "close" in value
  );
}

/**
 * Friendly message for re-submitting a dated fact on a date that already has one
 * (a UNIQUE-index collision). Generic across dated-fact kinds — revisions,
 * re-baselines, early repayments — so the copy names neither.
 */
export const DUPLICATE_DATED_FACT_MESSAGE =
  "Ya existe un registro con esa fecha. Edítalo o bórralo en su lugar.";

/**
 * True for a SQLite UNIQUE-constraint violation. Dated-fact tables carry a
 * unique index per (entity, date) (schema pattern R9), so a same-date re-submit
 * throws this rather than silently duplicating. Narrowed to UNIQUE (not every
 * constraint) so a NOT NULL / CHECK failure still surfaces as the real bug.
 */
function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, extendedCode, message, cause } = error as {
    code?: unknown;
    extendedCode?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  // Drizzle wraps the driver error ("Failed query: …") and carries the real
  // LibsqlError on `.cause`, so walk the chain, not just the top level.
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    extendedCode === "SQLITE_CONSTRAINT_UNIQUE" ||
    (typeof message === "string" && message.includes("UNIQUE constraint failed")) ||
    (cause !== undefined && cause !== error && isUniqueConstraintError(cause))
  );
}

/**
 * `runActionWithStore` for a dated-fact write (issue #692): the write sits behind
 * a unique index per (entity, date), so re-submitting the same date throws a raw
 * SQL error that would otherwise bubble to a 500. This translates that ONE error
 * class into the action's own `{ ok: false }` result — one guard for every
 * dated-fact action instead of a per-action try/catch. The transactional seam
 * (dated-fact-seams) rolls the failed insert back, so no partial write survives.
 * Any other throw is re-raised unchanged.
 */
export async function runDatedFactAction<T extends { ok: boolean; error?: string }>(
  fn: (store: WorthlineStore) => Promise<T>,
  injectedStore?: WorthlineStore,
): Promise<T | { ok: false; error: string }> {
  try {
    return await runActionWithStore(fn, injectedStore);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { ok: false, error: DUPLICATE_DATED_FACT_MESSAGE };
    }
    throw error;
  }
}
