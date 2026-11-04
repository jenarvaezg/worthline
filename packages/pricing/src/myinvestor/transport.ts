/**
 * How a request reaches MyInvestor: through the Cloudflare Worker relay (ADR 0114,
 * decision 10). From Vercel's egress MyInvestor answers `403 SECURITY_001`, so the
 * client never calls `api.myinvestor.es` itself. It sends each request to the relay
 * with the shared secret and the target URL in two headers; the relay forwards it
 * and hands the answer back untouched.
 *
 * The transport only moves bytes. It never retries nor reads a body: the error map
 * and the retries are the client's (`exchange.ts`).
 */
import { PRICING_FETCH_TIMEOUT_MS } from "@pricing/fetch-with-retry";
import {
  MYINVESTOR_API_ORIGIN,
  RELAY_ERROR_HEADER,
  RELAY_SECRET_HEADER,
  RELAY_TARGET_HEADER,
} from "./protocol";
import type { MyInvestorRelayConfig } from "./relay-config";

/** What the web app sends with every call (from `myinvestor-cli` and the prototype of #1866). */
const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  accept: "application/json",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
  origin: "https://newapp.myinvestor.es",
  referer: "https://newapp.myinvestor.es/",
  "x-myinvestor-app": "version=3.134.0,platform=web",
};

export interface MyInvestorRequest {
  readonly method: "GET" | "POST";
  /** Absolute path on `api.myinvestor.es`, e.g. `/login/api/v2/auth/token`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** Sent as JSON. */
  readonly body?: unknown;
}

export type TransportOutcome =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly contentType: string;
      readonly text: string;
      /** Set when the relay itself refused or failed (`x-relay-error`), not MyInvestor. */
      readonly relayError: string | null;
    }
  | { readonly kind: "unreachable"; readonly reason: "timeout" | "network" };

export interface MyInvestorTransport {
  send(request: MyInvestorRequest): Promise<TransportOutcome>;
}

export interface RelayTransportOptions {
  readonly fetchImpl?: typeof fetch;
  /** Per request; default {@link PRICING_FETCH_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** The MyInvestor URL a request targets. Throws on a path that could leave the host. */
export function myInvestorTarget(request: MyInvestorRequest): string {
  if (!request.path.startsWith("/") || request.path.startsWith("//")) {
    throw new RangeError("A MyInvestor path must be absolute on api.myinvestor.es");
  }
  const url = new URL(request.path, MYINVESTOR_API_ORIGIN);
  if (url.origin !== MYINVESTOR_API_ORIGIN) {
    throw new RangeError("A MyInvestor path must stay on api.myinvestor.es");
  }
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.append(key, value);
  }
  return url.toString();
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

export function createRelayTransport(
  config: MyInvestorRelayConfig,
  options: RelayTransportOptions = {},
): MyInvestorTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PRICING_FETCH_TIMEOUT_MS;

  return {
    async send(request) {
      const target = myInvestorTarget(request);
      const hasBody = request.body !== undefined;
      const headers: Record<string, string> = {
        ...BROWSER_HEADERS,
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...request.headers,
        [RELAY_SECRET_HEADER]: config.secret,
        [RELAY_TARGET_HEADER]: target,
      };
      try {
        const response = await fetchImpl(config.url, {
          method: request.method,
          headers,
          ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        return {
          kind: "response",
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          text: await response.text(),
          relayError: response.headers.get(RELAY_ERROR_HEADER),
        };
      } catch (error) {
        return { kind: "unreachable", reason: isTimeout(error) ? "timeout" : "network" };
      }
    },
  };
}
