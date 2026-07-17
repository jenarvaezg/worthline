import { cronBearerAuthorized } from "@web/cron-auth";
import { productionSyncQueue } from "@web/sync-queue";
import { dailyCaptureDescriptor } from "@worthline/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Fleet snapshot capture cron (ADR 0037, PRD #528, #895; #1064). Scheduled TWICE
 * daily by `vercel.json` — ≈09:00 UTC (provisional intraday point) and ≈21:00 UTC
 * (day's close, latest-wins). Each pass ENQUEUES a `daily-capture` job onto the
 * durable queue (PRD #999 S4) keyed by the pass-qualified run key, pinning the
 * capture instant at enqueue time. In the default pull mode the job drains
 * in-process here (same cost as the pre-S4 inline capture) AND sweeps any ready
 * `source-sync` jobs a crashed drain left behind; with a Vercel Queues transport
 * the doorbell is rung and the push consumer drains. Idempotent under redelivery:
 * the run-key single-flight + `runDailyCapture`'s finalization guard + latest-wins
 * capture compose so a re-delivered pass never captures twice.
 *
 * Guarded by a `CRON_SECRET` bearer: an anonymous caller cannot trigger this
 * expensive, cross-tenant-mutating job, while any scheduler holding the token can.
 * Fails closed — no secret configured means no trigger. Vercel Cron invokes with
 * GET and `Authorization: Bearer <CRON_SECRET>`; POST is exposed for a manual
 * trigger by a token holder.
 */
async function handler(req: Request): Promise<Response> {
  if (!cronBearerAuthorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const now = new Date().toISOString();
  const { job, enqueued } = await productionSyncQueue().enqueue({
    descriptor: dailyCaptureDescriptor(now),
    workspaceId: null,
  });
  return Response.json({
    dedupeKey: job.dedupeKey,
    enqueued,
    jobId: job.id,
    status: job.status,
  });
}

export { handler as GET, handler as POST };
