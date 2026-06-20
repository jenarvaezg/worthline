import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

import type { WorthlineStore } from "@worthline/db";
import { systemClock } from "@worthline/domain";

import {
  AgentViewHttpError,
  errorEnvelope,
  successEnvelope,
  type AgentViewConnectedSourcePositionGroupPage,
  type AgentViewConnectedSourcePositionPage,
  type AgentViewDataQualityCategory,
  type AgentViewDataQualityPage,
  type AgentViewDataQualitySeverity,
  type AgentViewErrorEnvelope,
  type AgentViewIncludeHoldingRows,
  type AgentViewOperationPage,
  type AgentViewOperationSort,
  type AgentViewSnapshotGranularity,
  type AgentViewSnapshotHistory,
  type AgentViewSnapshotSort,
  type AgentViewTrashSummary,
} from "./contract";
import {
  buildHoldingConnectedSourcePositions,
  buildSourceConnectedSourcePositions,
  DEFAULT_POSITION_LIMIT,
  MAX_POSITION_LIMIT,
} from "./connected-source-positions";
import {
  buildDataQuality,
  DEFAULT_DATA_QUALITY_LIMIT,
  MAX_DATA_QUALITY_LIMIT,
} from "./data-quality";
import { buildFinancialContext } from "./financial-context";
import { buildFigureExplanation, isFigureName } from "./figure-explanations";
import { buildFireContext } from "./fire-context";
import { buildHoldingDetail } from "./holding-detail";
import {
  buildHoldingOperations,
  DEFAULT_OPERATION_LIMIT,
  MAX_OPERATION_LIMIT,
} from "./holding-operations";
import { listAgentViewScopes } from "./scopes";
import {
  buildSnapshotHistory,
  DEFAULT_SNAPSHOT_LIMIT,
  MAX_SNAPSHOT_LIMIT,
} from "./snapshot-history";
import { buildTrashSummary, DEFAULT_TRASH_LIMIT, MAX_TRASH_LIMIT } from "./trash-summary";

type StoreRunner = <T>(run: (store: WorthlineStore) => T | Promise<T>) => Promise<T>;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

export async function handleListScopes(
  request: NextRequest,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, []);

    return json(
      successEnvelope(
        await runWithStore((store) => listAgentViewScopes(store.agentView)),
      ),
      200,
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleGetFinancialContext(
  request: NextRequest,
  scopeId: string,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, ["holdingLimit"]);

    const asOf = systemClock().today();
    const holdingLimit = parseHoldingLimit(
      new URL(request.url).searchParams.get("holdingLimit"),
    );

    return json(
      successEnvelope(
        await runWithStore((store) =>
          buildFinancialContext(store.agentView, { asOf, holdingLimit, scopeId }),
        ),
      ),
      200,
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * FIRE context is current-only (PRD #328, #340): the only honored query param is
 * `date`, which is rejected as `422 unsupported_historical_fire` so a caller
 * never receives an invented or nearest-date historical FIRE figure. Any other
 * unknown param is the standard `400` from `guardAgentViewRequest`.
 */
export async function handleGetFireContext(
  request: NextRequest,
  scopeId: string,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, ["date"]);

    if (new URL(request.url).searchParams.has("date")) {
      throw new AgentViewHttpError({
        code: "unprocessable_entity",
        details: { reason: "unsupported_historical_fire" },
        message: "Historical FIRE is not supported.",
        status: 422,
      });
    }

    return json(
      successEnvelope(
        await runWithStore((store) => buildFireContext(store.agentView, { scopeId })),
      ),
      200,
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Explain one figure for a scope (PRD #328, #343, #344). The `{figure}` path param
 * is validated against the known enum — an unknown name is a `400` carrying
 * `details: { reason: "invalid_figure", figure }`. `holdingId` (the `holding_value`
 * selector) and `date` are allowlisted. A `date` (`YYYY-MM-DD`, validated by
 * `isIsoCalendarDate` — malformed is a `400`) switches the explanation to
 * HISTORICAL mode against the scope's frozen snapshot for that exact day; no
 * `date` keeps the CURRENT-mode behaviour (#343) unchanged.
 */
export async function handleExplainFigure(
  request: NextRequest,
  scopeId: string,
  figure: string,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, ["holdingId", "date"]);

    if (!isFigureName(figure)) {
      throw new AgentViewHttpError({
        code: "bad_request",
        details: { figure, reason: "invalid_figure" },
        message: "Unknown figure.",
        status: 400,
      });
    }

    const params = new URL(request.url).searchParams;
    const asOf = systemClock().today();
    const holdingId = params.get("holdingId") ?? undefined;
    const date = parseIsoDate(params.get("date"), "date");

    return json(
      successEnvelope(
        await runWithStore((store) =>
          buildFigureExplanation(store.agentView, {
            asOf,
            figure,
            holdingId,
            scopeId,
            ...(date === undefined ? {} : { date }),
          }),
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

export async function handleGetSnapshotHistory(
  request: NextRequest,
  scopeId: string,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
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

    const history = await runWithStore((store) =>
      buildSnapshotHistory(store.agentView, options),
    );

    return json(snapshotEnvelope(request, history), 200);
  } catch (error) {
    return toErrorResponse(error);
  }
}

const DATA_QUALITY_QUERY_PARAMS = ["category", "severity", "limit", "cursor"];

const DATA_QUALITY_CATEGORIES: readonly AgentViewDataQualityCategory[] = [
  "warning",
  "price_freshness",
  "source_freshness",
  "missing_configuration",
  "history_coverage",
  "projection_gap",
];

const DATA_QUALITY_SEVERITIES: readonly AgentViewDataQualitySeverity[] = [
  "high",
  "medium",
  "low",
];

export async function handleGetDataQuality(
  request: NextRequest,
  scopeId: string,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, DATA_QUALITY_QUERY_PARAMS);

    const params = new URL(request.url).searchParams;
    const options = {
      cursor: params.get("cursor") ?? undefined,
      limit: parseDataQualityLimit(params.get("limit")),
      scopeId,
      ...(parseDataQualityCategory(params.get("category")) === undefined
        ? {}
        : { category: parseDataQualityCategory(params.get("category")) }),
      ...(parseDataQualitySeverity(params.get("severity")) === undefined
        ? {}
        : { severity: parseDataQualitySeverity(params.get("severity")) }),
    };

    const page = await runWithStore((store) =>
      buildDataQuality(store.agentView, options),
    );

    return json(dataQualityEnvelope(request, page), 200);
  } catch (error) {
    return toErrorResponse(error);
  }
}

const TRASH_QUERY_PARAMS = ["limit", "cursor"];

export async function handleGetTrashSummary(
  request: NextRequest,
  scopeId: string,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, TRASH_QUERY_PARAMS);

    const params = new URL(request.url).searchParams;
    const options = {
      cursor: params.get("cursor") ?? undefined,
      limit: parseTrashLimit(params.get("limit")),
      scopeId,
    };

    const summary = await runWithStore((store) =>
      buildTrashSummary(store.agentView, options),
    );

    return json(trashSummaryEnvelope(request, summary), 200);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleGetHoldingDetail(
  request: NextRequest,
  holdingId: string,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, []);

    return json(
      successEnvelope(
        await runWithStore((store) => buildHoldingDetail(store.agentView, holdingId)),
      ),
      200,
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

const OPERATION_QUERY_PARAMS = ["from", "to", "sort", "limit", "cursor"];

export async function handleGetHoldingOperations(
  request: NextRequest,
  holdingId: string,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, OPERATION_QUERY_PARAMS);

    const params = new URL(request.url).searchParams;
    const options = {
      cursor: params.get("cursor") ?? undefined,
      from: parseIsoDate(params.get("from"), "from"),
      holdingId,
      limit: parseOperationLimit(params.get("limit")),
      sort: parseOperationSort(params.get("sort")),
      to: parseIsoDate(params.get("to"), "to"),
    };

    const page = await runWithStore((store) =>
      buildHoldingOperations(store.agentView, options),
    );

    return json(operationsEnvelope(request, page), 200);
  } catch (error) {
    return toErrorResponse(error);
  }
}

const POSITION_QUERY_PARAMS = ["limit", "cursor"];

export async function handleGetHoldingConnectedSourcePositions(
  request: NextRequest,
  holdingId: string,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, POSITION_QUERY_PARAMS);

    const params = new URL(request.url).searchParams;
    const options = {
      cursor: params.get("cursor") ?? undefined,
      holdingId,
      limit: parsePositionLimit(params.get("limit")),
    };

    const page = await runWithStore((store) =>
      buildHoldingConnectedSourcePositions(store.agentView, options),
    );

    return json(holdingPositionsEnvelope(request, page), 200);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleGetSourcePositions(
  request: NextRequest,
  sourceId: string,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, POSITION_QUERY_PARAMS);

    const params = new URL(request.url).searchParams;
    const options = {
      cursor: params.get("cursor") ?? undefined,
      limit: parsePositionLimit(params.get("limit")),
      sourceId,
    };

    const page = await runWithStore((store) =>
      buildSourceConnectedSourcePositions(store.agentView, options),
    );

    return json(sourcePositionsEnvelope(request, page), 200);
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

/**
 * Envelope a data-quality page: the signals as `data`, the pagination facts as
 * `meta`, and `links.self` plus `links.next` (the same URL carrying the
 * `nextCursor`) when more pages remain — the same shape as a snapshot page.
 */
function dataQualityEnvelope(request: NextRequest, page: AgentViewDataQualityPage) {
  const self = new URL(request.url);
  const links: Record<string, string> = { self: self.pathname + self.search };

  if (page.meta.nextCursor !== undefined) {
    const next = new URL(request.url);
    next.searchParams.set("cursor", page.meta.nextCursor);
    links.next = next.pathname + next.search;
  }

  return { data: page.signals, links, meta: page.meta };
}

/**
 * Envelope a trash-summary page: the trashed holdings as `data`, the pagination
 * facts as `meta`, and `links.self` plus `links.next` (the same URL carrying the
 * `nextCursor`) when more pages remain — the same shape as a snapshot page.
 */
function trashSummaryEnvelope(request: NextRequest, summary: AgentViewTrashSummary) {
  const self = new URL(request.url);
  const links: Record<string, string> = { self: self.pathname + self.search };

  if (summary.meta.nextCursor !== undefined) {
    const next = new URL(request.url);
    next.searchParams.set("cursor", summary.meta.nextCursor);
    links.next = next.pathname + next.search;
  }

  return { data: summary.holdings, links, meta: summary.meta };
}

/**
 * Envelope an operations page: the rows as `data`, the pagination facts as
 * `meta`, and `links.self` plus `links.next` (the same URL carrying the
 * `nextCursor`) when more pages remain — the same shape as a snapshot page.
 */
function operationsEnvelope(request: NextRequest, page: AgentViewOperationPage) {
  const self = new URL(request.url);
  const links: Record<string, string> = { self: self.pathname + self.search };

  if (page.meta.nextCursor !== undefined) {
    const next = new URL(request.url);
    next.searchParams.set("cursor", page.meta.nextCursor);
    links.next = next.pathname + next.search;
  }

  return { data: page.operations, links, meta: page.meta };
}

/**
 * Envelope a holding-scoped positions page: the positions as `data`, the
 * pagination facts as `meta`, and `links.self`/`links.next` — the same shape as
 * an operations page.
 */
function holdingPositionsEnvelope(
  request: NextRequest,
  page: AgentViewConnectedSourcePositionPage,
) {
  const self = new URL(request.url);
  const links: Record<string, string> = { self: self.pathname + self.search };

  if (page.meta.nextCursor !== undefined) {
    const next = new URL(request.url);
    next.searchParams.set("cursor", page.meta.nextCursor);
    links.next = next.pathname + next.search;
  }

  return { data: page.positions, links, meta: page.meta };
}

/**
 * Envelope a source-scoped positions page: the grouped positions as `data`, the
 * pagination facts as `meta`, and `links.self`/`links.next` when more remain.
 */
function sourcePositionsEnvelope(
  request: NextRequest,
  page: AgentViewConnectedSourcePositionGroupPage,
) {
  const self = new URL(request.url);
  const links: Record<string, string> = { self: self.pathname + self.search };

  if (page.meta.nextCursor !== undefined) {
    const next = new URL(request.url);
    next.searchParams.set("cursor", page.meta.nextCursor);
    links.next = next.pathname + next.search;
  }

  return { data: page.groups, links, meta: page.meta };
}

/** Parse the positions `limit`: positive integer, clamped to the documented max. */
function parsePositionLimit(raw: string | null): number {
  if (raw === null) {
    return DEFAULT_POSITION_LIMIT;
  }

  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { limit: raw },
      message: "limit must be a positive integer.",
      status: 400,
    });
  }

  return Math.min(Number(raw), MAX_POSITION_LIMIT);
}

/** Parse `sort` for operations; defaults newest-first (`-date`). */
function parseOperationSort(raw: string | null): AgentViewOperationSort {
  if (raw === null) {
    return "-date";
  }

  if (raw !== "date" && raw !== "-date") {
    throw enumError("sort", raw);
  }

  return raw;
}

/** Parse the operations `limit`: positive integer, clamped to the documented max. */
function parseOperationLimit(raw: string | null): number {
  if (raw === null) {
    return DEFAULT_OPERATION_LIMIT;
  }

  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { limit: raw },
      message: "limit must be a positive integer.",
      status: 400,
    });
  }

  return Math.min(Number(raw), MAX_OPERATION_LIMIT);
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

/** Parse the data-quality `limit`: positive integer, clamped to the documented max. */
function parseDataQualityLimit(raw: string | null): number {
  if (raw === null) {
    return DEFAULT_DATA_QUALITY_LIMIT;
  }

  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { limit: raw },
      message: "limit must be a positive integer.",
      status: 400,
    });
  }

  return Math.min(Number(raw), MAX_DATA_QUALITY_LIMIT);
}

/** Parse the trash-summary `limit`: positive integer, clamped to the documented max. */
function parseTrashLimit(raw: string | null): number {
  if (raw === null) {
    return DEFAULT_TRASH_LIMIT;
  }

  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { limit: raw },
      message: "limit must be a positive integer.",
      status: 400,
    });
  }

  return Math.min(Number(raw), MAX_TRASH_LIMIT);
}

/** Parse the data-quality `category` filter; an unknown value is a `400`. */
function parseDataQualityCategory(
  raw: string | null,
): AgentViewDataQualityCategory | undefined {
  if (raw === null) {
    return undefined;
  }

  if (!DATA_QUALITY_CATEGORIES.includes(raw as AgentViewDataQualityCategory)) {
    throw enumError("category", raw);
  }

  return raw as AgentViewDataQualityCategory;
}

/** Parse the data-quality `severity` filter; an unknown value is a `400`. */
function parseDataQualitySeverity(
  raw: string | null,
): AgentViewDataQualitySeverity | undefined {
  if (raw === null) {
    return undefined;
  }

  if (!DATA_QUALITY_SEVERITIES.includes(raw as AgentViewDataQualitySeverity)) {
    throw enumError("severity", raw);
  }

  return raw as AgentViewDataQualitySeverity;
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
