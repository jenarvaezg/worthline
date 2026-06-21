/**
 * Server adapter for the demo context (PRD #297, ADR 0030). Resolves the
 * request's {@link StoreTarget} (session + env + persona cookie) and projects it
 * into the {@link DemoContext} via the pure {@link demoContextFromTarget}. Kept
 * apart from the pure projection so the latter stays a `next/headers`-free unit.
 */
import { demoContextFromTarget, type DemoContext } from "@web/demo/demo-context";
import { readStoreTarget } from "@web/read-store-target";

export async function readDemoContext(): Promise<DemoContext> {
  return demoContextFromTarget(await readStoreTarget());
}
