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
 * Its own refusals carry `x-relay-error`, so the client tells them apart from
 * MyInvestor's answers. The header names are the same literals as
 * `packages/pricing/src/myinvestor/transport.ts`.
 */

export interface RelayEnv {
  /** `wrangler secret put RELAY_SECRET`; the same value as worthline's MYINVESTOR_RELAY_SECRET. */
  readonly RELAY_SECRET?: string;
}

const SECRET_HEADER = "x-relay-secret";
const TARGET_HEADER = "x-relay-target";
const ERROR_HEADER = "x-relay-error";
const ALLOWED_HOST = "api.myinvestor.es";

/** The headers MyInvestor needs; anything else (Cloudflare's, the relay's own) stays here. */
const FORWARDED_HEADERS = [
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "origin",
  "referer",
  "user-agent",
  "x-device-id",
  "x-myinvestor-app",
  "x-signature-id",
] as const;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

function refuse(status: number, error: string): Response {
  return new Response(null, { status, headers: { [ERROR_HEADER]: error } });
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
function allowedTarget(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const exact =
    url.protocol === "https:" &&
    url.hostname === ALLOWED_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "";
  return exact ? url.toString() : null;
}

export async function handleRelay(
  request: Request,
  env: RelayEnv,
  fetchImpl: Fetch,
): Promise<Response> {
  const expected = env.RELAY_SECRET ?? "";
  if (!expected) return refuse(500, "misconfigured");

  const given = request.headers.get(SECRET_HEADER) ?? "";
  if (!(await sameSecret(given, expected))) return refuse(401, "unauthorized");

  if (request.method !== "GET" && request.method !== "POST") {
    return refuse(405, "method_not_allowed");
  }

  const rawTarget = request.headers.get(TARGET_HEADER);
  if (!rawTarget) return refuse(400, "missing_target");
  const target = allowedTarget(rawTarget);
  if (!target) return refuse(403, "forbidden_target");

  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
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
