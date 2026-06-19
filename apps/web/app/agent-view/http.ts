import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

import type { WorthlineStore } from "@worthline/db";
import { systemClock } from "@worthline/domain";

import {
  AgentViewHttpError,
  errorEnvelope,
  successEnvelope,
  type AgentViewErrorEnvelope,
  type AgentViewIncludeHoldingRows,
  type AgentViewSnapshotGranularity,
  type AgentViewSnapshotHistory,
  type AgentViewSnapshotSort,
} from "./contract";
import { buildFinancialContext } from "./financial-context";
import { listAgentViewScopes } from "./scopes";
import {
  buildSnapshotHistory,
  DEFAULT_SNAPSHOT_LIMIT,
  MAX_SNAPSHOT_LIMIT,
} from "./snapshot-history";

type StoreRunner = <T>(run: (store: WorthlineStore) => T) => T;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

export function handleListScopes(
  request: NextRequest,
  runWithStore: StoreRunner,
): NextResponse {
  try {
    guardAgentViewRequest(request, []);

    return json(
      successEnvelope(runWithStore((store) => listAgentViewScopes(store.agentView))),
      200,
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export function handleGetFinancialContext(
  request: NextRequest,
  scopeId: string,
  runWithStore: StoreRunner,
): NextResponse {
  try {
    guardAgentViewRequest(request, ["holdingLimit"]);

    const asOf = systemClock().today();
    const holdingLimit = parseHoldingLimit(
      new URL(request.url).searchParams.get("holdingLimit"),
    );

    return json(
      successEnvelope(
        runWithStore((store) =>
          buildFinancialContext(store.agentView, { asOf, holdingLimit, scopeId }),
        ),
      ),
      200,
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

const SNAPSHOT_QUERY_PARAMS = [
  "granularity",
  "from",
  "to",
  "sort",
  "limit",
  "cursor",
  "includeHoldingRows",
];

export function handleGetSnapshotHistory(
  request: NextRequest,
  scopeId: string,
  runWithStore: StoreRunner,
): NextResponse {
  try {
    guardAgentViewRequest(request, SNAPSHOT_QUERY_PARAMS);

    const params = new URL(request.url).searchParams;
    const options = {
      cursor: params.get("cursor") ?? undefined,
      from: parseIsoDate(params.get("from"), "from"),
      granularity: parseGranularity(params.get("granularity")),
      includeHoldingRows: parseIncludeHoldingRows(params.get("includeHoldingRows")),
      limit: parseSnapshotLimit(params.get("limit")),
      scopeId,
      sort: parseSort(params.get("sort")),
      to: parseIsoDate(params.get("to"), "to"),
    };

    const history = runWithStore((store) =>
      buildSnapshotHistory(store.agentView, options),
    );

    return json(snapshotEnvelope(request, history), 200);
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Envelope a snapshot page: the entries as `data`, the pagination facts as
 * `meta`, and `links.self` plus `links.next` (the same URL carrying the
 * `nextCursor`) when more pages remain.
 */
function snapshotEnvelope(request: NextRequest, history: AgentViewSnapshotHistory) {
  const self = new URL(request.url);
  const links: Record<string, string> = { self: self.pathname + self.search };

  if (history.meta.nextCursor !== undefined) {
    const next = new URL(request.url);
    next.searchParams.set("cursor", history.meta.nextCursor);
    links.next = next.pathname + next.search;
  }

  return { data: history.entries, links, meta: history.meta };
}

function parseGranularity(raw: string | null): AgentViewSnapshotGranularity {
  if (raw === null) {
    return "monthly-close";
  }

  if (raw !== "monthly-close" && raw !== "raw") {
    throw enumError("granularity", raw);
  }

  return raw;
}

function parseSort(raw: string | null): AgentViewSnapshotSort {
  if (raw === null) {
    return "date";
  }

  if (raw !== "date" && raw !== "-date") {
    throw enumError("sort", raw);
  }

  return raw;
}

function parseIncludeHoldingRows(raw: string | null): AgentViewIncludeHoldingRows {
  if (raw === null) {
    return "none";
  }

  if (raw !== "none" && raw !== "summary" && raw !== "full") {
    throw enumError("includeHoldingRows", raw);
  }

  return raw;
}

/** Parse `limit`: positive integer, clamped to the documented max (over-max clamps). */
function parseSnapshotLimit(raw: string | null): number {
  if (raw === null) {
    return DEFAULT_SNAPSHOT_LIMIT;
  }

  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { limit: raw },
      message: "limit must be a positive integer.",
      status: 400,
    });
  }

  return Math.min(Number(raw), MAX_SNAPSHOT_LIMIT);
}

/** Validate an ISO calendar date (`YYYY-MM-DD`); rejects malformed and non-existent dates. */
function parseIsoDate(raw: string | null, field: string): string | undefined {
  if (raw === null) {
    return undefined;
  }

  if (!isIsoCalendarDate(raw)) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { [field]: raw },
      message: `${field} must be an ISO calendar date (YYYY-MM-DD).`,
      status: 400,
    });
  }

  return raw;
}

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function enumError(field: string, value: string): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "bad_request",
    details: { [field]: value },
    message: `Invalid ${field} value.`,
    status: 400,
  });
}

function parseHoldingLimit(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }

  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { holdingLimit: raw },
      message: "holdingLimit must be a positive integer.",
      status: 400,
    });
  }

  return Number(raw);
}

function guardAgentViewRequest(request: NextRequest, allowedQueryParams: string[]): void {
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

function toErrorResponse(error: unknown): NextResponse<AgentViewErrorEnvelope> {
  if (error instanceof AgentViewHttpError) {
    return json(errorEnvelope(error), error.status);
  }

  console.error("Agent view request failed", error);
  return json(
    errorEnvelope(
      new AgentViewHttpError({
        code: "internal_error",
        message: "Agent view request failed.",
        status: 500,
      }),
    ),
    500,
  );
}

function json<T>(body: T, status: number): NextResponse<T> {
  return NextResponse.json(body, {
    headers: NO_STORE_HEADERS,
    status,
  });
}
