import { authOAuthRatePlan } from "@web/api/mcp/rate-limit";
import { enforceMcpRateLimit } from "@web/api/mcp/rate-limit-store";
import { handlers } from "@web/auth";
import type { NextRequest } from "next/server";

const NO_STORE = { "Cache-Control": "no-store" };

function clientIp(request: Request): string | null {
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",").at(-1)?.trim() || null;
}

function isAuthConfigured(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}

/**
 * Auth.js OAuth callback rate limit (#1183). Vercel's platform DDoS/WAF also
 * applies at the edge; this counter is the app-owned backstop that fails closed
 * before the control-plane provisioning path runs on callback.
 */
async function gateAuthOAuthRequest(
  request: NextRequest,
  handler: (request: NextRequest) => Promise<Response>,
): Promise<Response> {
  if (!isAuthConfigured()) {
    return handler(request);
  }

  const outcome = await enforceMcpRateLimit(authOAuthRatePlan(clientIp(request)));
  if (outcome === "limited") {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { ...NO_STORE, "Content-Type": "application/json", "Retry-After": "3600" },
    });
  }
  if (outcome === "store_unavailable") {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...NO_STORE, "Content-Type": "application/json" },
    });
  }

  return handler(request);
}

export async function GET(request: NextRequest): Promise<Response> {
  // next-auth@5 still nests its own `next` types; under Cache Components /
  // Next 16.3 preview the public NextRequest is structurally compatible but
  // not assignable under exactOptionalPropertyTypes. Bridge at this seam.
  return gateAuthOAuthRequest(
    request,
    handlers.GET as unknown as (request: NextRequest) => Promise<Response>,
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  return gateAuthOAuthRequest(
    request,
    handlers.POST as unknown as (request: NextRequest) => Promise<Response>,
  );
}
