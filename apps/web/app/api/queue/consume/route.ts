import { cronBearerAuthorized } from "@web/cron-auth";
import { productionSyncQueue } from "@web/sync-queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Durable-queue drain endpoint (PRD #999 S4, #1064). Two roles over ONE handler,
 * because both reduce to "drain every ready job to idle":
 *
 *   - SWEEP: a scheduler (GET + `CRON_SECRET` bearer) drains anything the default
 *     pull-mode path could not — chiefly a job a crashed in-process drain left
 *     `leased`, whose lease lapses and is re-leased here. The twice-daily capture
 *     cron already sweeps, so this is NOT scheduled in `vercel.json`: the hosted
 *     account is Vercel Hobby (daily-only crons), which rejects a sub-daily
 *     `schedule`. A tighter cadence needs the push consumer below (or Pro) — do
 *     not re-add an hourly cron here or the deploy fails.
 *   - PUSH CONSUMER: when a Vercel Queues transport is configured, its doorbell
 *     (`{ jobId }`) POSTs here to drain promptly. The doorbell is best-effort — the
 *     `job` table is the source of truth — so this ignores the body and drains the
 *     next ready jobs regardless, which is correct for a lost or duplicated signal.
 *
 * Fails closed on the shared bearer gate. A real Vercel Queues binding would add
 * its own signature verification alongside this.
 */
async function handler(req: Request): Promise<Response> {
  if (!cronBearerAuthorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const outcomes = await productionSyncQueue().drain();
  return Response.json({ drained: outcomes.length, outcomes });
}

export { handler as GET, handler as POST };
