import { withAuthorizedStore } from "@web/principal";
import type { WorthlineStore } from "@worthline/db";

/**
 * The store runner every `/api/v1/agent-view/**` route hands to its HTTP handler
 * (#998 S2). That REST surface is the LOCAL single-user AFK stream (#328),
 * authorized by loopback binding + a capability bearer token
 * (`guardAgentViewRequest`). That authorization models a `local` principal — it
 * is NOT a shortcut to open a database — so the read enters through the
 * authorization port (`@web/principal`) like every other surface (RSC, MCP,
 * cron), and no route imports the raw `withStoreUnsafe` opener from
 * `@worthline/db` any longer.
 *
 * A hosted/authenticated caller never reaches these routes: the loopback +
 * token guard rejects it before the store is opened, so binding `local` here is
 * both correct and the only reachable principal for this surface.
 */
export function runAgentViewStore<T>(
  run: (store: WorthlineStore) => T | Promise<T>,
): Promise<T> {
  return withAuthorizedStore({ kind: "local" }, run, "agent-view");
}
