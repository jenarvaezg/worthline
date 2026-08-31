import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { AgentViewHttpError } from "./contract";

/**
 * The per-request gate every agent-view HTTP read passes through: unknown query
 * params are a `400`, a non-loopback caller a `403`, a missing or wrong capability
 * token a `401`. It is invoked from ONE place — the route table's
 * `defineAgentViewRoute` (#1695) — so a new endpoint cannot forget it.
 */
export function guardAgentViewRequest(
  request: NextRequest,
  allowedQueryParams: readonly string[],
): void {
  const url = new URL(request.url);
  const unknownParams = Array.from(url.searchParams.keys()).filter(
    (key) => !allowedQueryParams.includes(key),
  );

  if (unknownParams.length > 0) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { unknownParams },
      message: "Unknown query parameter.",
      status: 400,
    });
  }

  // The actual TCP peer is not exposed by NextRequest. Loopback binding is
  // enforced by the local Next entrypoints; this route rejects non-loopback Host
  // values and forwarded client chains as defence in depth.
  if (!isLoopbackHost(url.hostname) || !forwardedForIsLoopback(request)) {
    throw new AgentViewHttpError({
      code: "forbidden",
      message: "Agent view is only available from loopback addresses in local mode.",
      status: 403,
    });
  }

  const expectedToken = process.env.WORTHLINE_AGENT_VIEW_TOKEN;
  const suppliedToken = bearerToken(request.headers.get("authorization"));

  if (!expectedToken || !suppliedToken || !tokenMatches(suppliedToken, expectedToken)) {
    throw new AgentViewHttpError({
      code: "unauthorized",
      message: "Missing or invalid agent view capability token.",
      status: 401,
    });
  }
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

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function forwardedForIsLoopback(request: NextRequest): boolean {
  const forwardedFor = request.headers.get("x-forwarded-for");

  if (!forwardedFor) {
    return true;
  }

  return forwardedFor
    .split(",")
    .map((value) => value.trim())
    .every(isLoopbackHost);
}
