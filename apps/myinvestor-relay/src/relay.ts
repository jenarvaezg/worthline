/**
 * The MyInvestor relay (ADR 0114, decision 10; #1877). From Vercel's egress
 * MyInvestor answers `403 SECURITY_001 «Captcha required»`, while the same code
 * passes from a Cloudflare Worker (#1866). So worthline sends every call here and
 * this Worker forwards it to `api.myinvestor.es`, and nowhere else.
 *
 * It is thin on purpose:
 * - locked with a shared secret (`x-relay-secret`), compared in constant time;
 * - the target travels in `x-relay-target` and must be `https://api.myinvestor.es`;
 * - it never stores, logs nor reads a body: bytes in, bytes out;
 * - it has no state. Credentials travel sealed in worthline and only cross here per
 *   request; every decision (errors, retries, limits) is worthline's.
 *
 * - a POST goes through only to the sign-in routes (login, refresh, the SMS
 *   signature); everything else the connector does is a GET (PRD #1876, invariant 1).
 *
 * Its own refusals carry `x-relay-error`, so the client tells them apart from
 * MyInvestor's answers. The header names and the routes are the client's own
 * (`@worthline/pricing/myinvestor/protocol`, a file with no imports).
 */
import {
  DEVICE_ID_HEADER,
  isSignInPost,
  MYINVESTOR_API_HOST,
  RELAY_ERROR_HEADER,
  RELAY_SECRET_HEADER,
  RELAY_TARGET_HEADER,
  SIGNATURE_ID_HEADER,
} from "@worthline/pricing/myinvestor/protocol";

export interface RelayEnv {
  /** `wrangler secret put RELAY_SECRET`; the same value as worthline's MYINVESTOR_RELAY_SECRET. */
  readonly RELAY_SECRET?: string;
}

/** The headers MyInvestor needs; anything else (Cloudflare's, the relay's own) stays here. */
const FORWARDED_HEADERS = [
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "origin",
  "referer",
  "user-agent",
  DEVICE_ID_HEADER,
  "x-myinvestor-app",
  SIGNATURE_ID_HEADER,
] as const;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

function refuse(status: number, error: string): Response {
  return new Response(null, { status, headers: { [RELAY_ERROR_HEADER]: error } });
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

/** Equal secrets, without the time of the comparison saying how much of it matched. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([digest(given), digest(expected)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/** The target, only when it is exactly `https://api.myinvestor.es/…`. */
function allowedTarget(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const exact =
    url.protocol === "https:" &&
    url.hostname === MYINVESTOR_API_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "";
  return exact ? url : null;
}

export async function handleRelay(
  request: Request,
  env: RelayEnv,
  fetchImpl: Fetch,
): Promise<Response> {
  const expected = env.RELAY_SECRET ?? "";
  if (!expected) return refuse(500, "misconfigured");

  const given = request.headers.get(RELAY_SECRET_HEADER) ?? "";
  if (!(await sameSecret(given, expected))) return refuse(401, "unauthorized");

  if (request.method !== "GET" && request.method !== "POST") {
    return refuse(405, "method_not_allowed");
  }

  const rawTarget = request.headers.get(RELAY_TARGET_HEADER);
  if (!rawTarget) return refuse(400, "missing_target");
  const target = allowedTarget(rawTarget);
  if (!target) return refuse(403, "forbidden_target");
  if (request.method === "POST" && !isSignInPost(target.pathname)) {
    return refuse(403, "forbidden_route");
  }

  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(target.toString(), {
      method: request.method,
      headers,
      ...(request.method === "POST" ? { body: await request.arrayBuffer() } : {}),
      // A redirect could lead off api.myinvestor.es: it goes back to worthline as it is.
      redirect: "manual",
    });
  } catch {
    return refuse(502, "upstream_unreachable");
  }

  const answerHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) answerHeaders.set("content-type", contentType);
  return new Response(upstream.body, { status: upstream.status, headers: answerHeaders });
}
