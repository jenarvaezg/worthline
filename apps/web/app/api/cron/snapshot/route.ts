import { timingSafeEqual } from "node:crypto";

import { runDailyCapture } from "@worthline/db";

import { buildDailyCaptureDeps } from "./daily-capture-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Fleet snapshot capture cron (ADR 0037, PRD #528, #895). Scheduled TWICE daily
 * by `vercel.json` — ≈09:00 UTC (provisional intraday point) and ≈21:00 UTC
 * (day's close, latest-wins). Each pass refreshes fleet prices, syncs connected
 * sources, and captures. Guarded by a `CRON_SECRET` bearer: an anonymous caller cannot
 * trigger this expensive, cross-tenant-mutating job, while any scheduler holding
 * the token can. Fails closed — no secret configured means no trigger.
 *
 * Vercel Cron invokes with GET and `Authorization: Bearer <CRON_SECRET>`; POST
 * is exposed for a manual trigger by a token holder.
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const suppliedToken = bearerToken(req.headers.get("authorization"));
  return Boolean(suppliedToken && tokenMatches(suppliedToken, secret));
}

function bearerToken(header: string | null): string | null {
  const parts = header?.split(" ") ?? [];
  const [scheme, token] = parts;

  if (parts.length !== 2 || scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

function tokenMatches(suppliedToken: string, expectedToken: string): boolean {
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function handler(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await runDailyCapture(buildDailyCaptureDeps());
  return Response.json(result);
}

export { handler as GET, handler as POST };
