/**
 * The admin surface's control-plane seam (#697), mirroring `action-store.ts`'s
 * `runActionWithStore`: opens a `ControlPlaneStore` from env, hands it to
 * `run`, and always closes it — unless a store is injected (tests), whose
 * lifecycle the caller owns instead.
 *
 * The WIDE twin of `app/control-plane-store.ts` (#1694): identical lifecycle,
 * only the opener differs — this one is the sole surface from which exposure-
 * catalog curation writes are reachable (#1123), which is exactly why it stays a
 * separate module instead of an option on the shared helper. The env coordinates
 * are read by the shared `requireControlPlaneTarget`, so there is still one
 * place that knows how the control plane is addressed.
 */
import { requireControlPlaneTarget } from "@web/control-plane-store";
import { type AdminControlPlaneStore, createAdminControlPlaneStore } from "@worthline/db";

async function openControlPlaneStore(): Promise<AdminControlPlaneStore> {
  return createAdminControlPlaneStore(requireControlPlaneTarget("The admin surface"));
}

/**
 * Hand an admin control-plane port to `run`, opening (and always closing) the
 * real store unless one is injected. This is the `/admin` seam, so it opens the
 * wide {@link AdminControlPlaneStore} — the ONLY surface from which exposure-
 * catalog curation writes are reachable (#1123). Generic over the port `S` the
 * caller needs — `run`'s param and `injectedStore` narrow to just that concern,
 * so a caller touches only the methods it uses and a test can inject a fake of
 * that single port. `S` is constrained to a subset of `AdminControlPlaneStore`,
 * so the opened store (which implements every port) always satisfies it — the
 * widening cast is sound, and a foreign `S` is rejected at the call site.
 */
export async function withControlPlaneStore<
  T,
  S extends Partial<AdminControlPlaneStore> = AdminControlPlaneStore,
>(run: (store: S) => T | Promise<T>, injectedStore?: S): Promise<T> {
  if (injectedStore) {
    return run(injectedStore);
  }
  const store = await openControlPlaneStore();
  try {
    return await run(store as unknown as S);
  } finally {
    store.close();
  }
}
