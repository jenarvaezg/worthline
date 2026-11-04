import type { MyInvestorProgress } from "@web/ajustes/myinvestor-sync-progress";
import { readStoreTarget } from "@web/read-store-target";
import { withStore } from "@web/store";
import { type NextRequest, NextResponse } from "next/server";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * `GET /api/myinvestor/progress?sourceId=…` — the live steps of a MyInvestor pass
 * (#1884, design A). The panel's server action runs the pass and answers only when
 * it ends; meanwhile the panel polls here for the step the pass wrote down, and
 * for a pass it is waiting on (the cron's, another tab's). A plain GET, not a
 * server action: those run one at a time per client, and the pass is one already.
 *
 * Tenant isolation is not a parameter: the store is the session's own workspace
 * (`withStore`), and the source id only picks within it. Read-only and uncached;
 * it says nothing but a step and an instant.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const sourceId = new URL(request.url).searchParams.get("sourceId");
  if (!sourceId) {
    return NextResponse.json({ error: "sourceId" }, { headers: NO_STORE, status: 400 });
  }
  const target = await readStoreTarget();
  if (target.kind === "unauthenticated") {
    return NextResponse.json(
      { error: "unauthenticated" },
      { headers: NO_STORE, status: 401 },
    );
  }

  const progress = await withStore(async (store): Promise<MyInvestorProgress> => {
    const state = await store.connectedSources.readSyncState(sourceId);
    const lease = state?.lease ?? null;
    const now = new Date().toISOString();
    if (!lease || lease.until <= now) {
      return { now, running: false, startedAt: null, step: null };
    }
    return { now, running: true, startedAt: lease.startedAt, step: lease.step };
  }, target);
  return NextResponse.json(progress, { headers: NO_STORE });
}
