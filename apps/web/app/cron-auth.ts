import { timingSafeEqual } from "node:crypto";

/**
 * The shared `CRON_SECRET` bearer gate for the scheduler-triggered routes (the
 * daily-capture cron and the durable-queue drain/consumer). An anonymous caller
 * cannot trigger these expensive, cross-tenant-mutating jobs; any scheduler holding
 * the token can. Fails closed — no secret configured means no trigger. Constant-time
 * comparison so the token is not discoverable by timing.
 */
export function cronBearerAuthorized(req: Request): boolean {
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
