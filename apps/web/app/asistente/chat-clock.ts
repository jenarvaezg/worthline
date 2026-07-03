import type { StoreTarget } from "@web/store-resolver";

import { demoAsOfDateKey } from "@web/demo/demo-clock";

/**
 * The valuation date the chat tools read at (#629). Demo targets carry the
 * demo clock — which is "" (unpinned) in production, where the demo STORE
 * opens at today via demoAsOfDateKey — so the tool must resolve through the
 * same helper or the assistant's figures diverge from the dashboard's.
 */
export function chatAsOf(target: StoreTarget): string {
  if (target.kind === "demo") {
    return demoAsOfDateKey(target.now);
  }

  return new Date().toISOString().slice(0, 10);
}
