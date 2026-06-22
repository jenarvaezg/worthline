import { withStore, type WorthlineStore } from "@web/store";

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
