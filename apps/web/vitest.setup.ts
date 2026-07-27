import { vi } from "vitest";

/**
 * Global `next/cache` stub for the node test environment.
 *
 * The `formAction` combinator (app/form-action.ts) calls `revalidatePath` on
 * every successful mutation to bust the client Router Cache (#1191). The real
 * `next/cache` implementation needs Next's request/work store, which the plain
 * `node` vitest environment does not provide, so an unmocked call throws and
 * would break every action test that drives a mutation through the combinator.
 *
 * Stubbing here — rather than in each of the ~26 action test files — keeps a
 * single source of truth. `revalidatePath`/`revalidateTag` become
 * no-ops, and `unstable_cache` (used by read-benchmark-prices.ts) passes the
 * wrapped function through unchanged so cached reads still execute. Test files
 * that assert on cache behavior (form-action.test.ts, read-benchmark-prices.test.ts)
 * declare their own per-file `vi.mock("next/cache", …)`, which takes precedence
 * over this one.
 */
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache:
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R =>
      fn(...args),
}));
