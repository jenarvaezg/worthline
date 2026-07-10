import { timingSafeEqual } from "node:crypto";
import { type WorthlineStore } from "@worthline/db";
import { type NextRequest, NextResponse } from "next/server";

import {
  createAgentViewCatalog,
  type GetConnectedSourcePositionsInput,
  type GetDataQualityInput,
  type GetOperationsInput,
  type GetSnapshotHistoryInput,
  type GetTrashSummaryInput,
} from "./catalog";
import { DEFAULT_POSITION_LIMIT, MAX_POSITION_LIMIT } from "./connected-source-positions";
import {
  type AgentViewDataQualityCategory,
  type AgentViewDataQualitySeverity,
  type AgentViewEnvelope,
  type AgentViewErrorEnvelope,
  AgentViewHttpError,
  type AgentViewIncludeHoldingRows,
  type AgentViewOperationSort,
  type AgentViewPaginationMeta,
  type AgentViewSnapshotGranularity,
  type AgentViewSnapshotSort,
  errorEnvelope,
} from "./contract";
import { DEFAULT_DATA_QUALITY_LIMIT, MAX_DATA_QUALITY_LIMIT } from "./data-quality";
import { isFigureName } from "./figure-explanations";
import { DEFAULT_OPERATION_LIMIT, MAX_OPERATION_LIMIT } from "./holding-operations";
import { pagedHttpEnvelope, parsePositiveLimit } from "./pagination";
import { isAgentViewErrorEnvelope, runCatalogRead } from "./read-backend";
import { DEFAULT_SNAPSHOT_LIMIT, MAX_SNAPSHOT_LIMIT } from "./snapshot-history";
import { DEFAULT_TRASH_LIMIT, MAX_TRASH_LIMIT } from "./trash-summary";

type StoreRunner = <T>(run: (store: WorthlineStore) => T | Promise<T>) => Promise<T>;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

const catalog = createAgentViewCatalog();

export async function handleListScopes(
  request: NextRequest,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, []);

    return await runWithStore((store) =>
      catalogJson(runCatalogRead(catalog.list_scopes, {}, store.agentView)),
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

    const holdingLimit = parseHoldingLimit(
      new URL(request.url).searchParams.get("holdingLimit"),
    );

    return await runWithStore((store) =>
      catalogJson(
        runCatalogRead(
          catalog.get_financial_context,
          {
            scopeId,
            ...(holdingLimit === undefined ? {} : { holdingLimit }),
          },
          store.agentView,
        ),
      ),
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

    return await runWithStore((store) =>
      catalogJson(runCatalogRead(catalog.get_fire_context, { scopeId }, store.agentView)),
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
    const holdingId = params.get("holdingId") ?? undefined;
    const date = parseIsoDate(params.get("date"), "date");

    return await runWithStore((store) =>
      catalogJson(
        runCatalogRead(
          catalog.explain_figure,
          {
            figure,
            scopeId,
            ...(holdingId === undefined ? {} : { holdingId }),
            ...(date === undefined ? {} : { date }),
          },
          store.agentView,
        ),
      ),
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
    const input: GetSnapshotHistoryInput = {
      scopeId,
      granularity: parseGranularity(params.get("granularity")),
      includeHoldingRows: parseIncludeHoldingRows(params.get("includeHoldingRows")),
      limit: parsePositiveLimit(params.get("limit"), {
        defaultLimit: DEFAULT_SNAPSHOT_LIMIT,
        maxLimit: MAX_SNAPSHOT_LIMIT,
      }),
      sort: parseSort(params.get("sort")),
      ...(params.get("cursor") ? { cursor: params.get("cursor")! } : {}),
      ...(parseIsoDate(params.get("from"), "from")
        ? { from: parseIsoDate(params.get("from"), "from")! }
        : {}),
      ...(parseIsoDate(params.get("to"), "to")
        ? { to: parseIsoDate(params.get("to"), "to")! }
        : {}),
    };

    return await runWithStore((store) =>
      catalogPagedJson(
        request,
        runCatalogRead(catalog.get_snapshot_history, input, store.agentView),
      ),
    );
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
    const category = parseDataQualityCategory(params.get("category"));
    const severity = parseDataQualitySeverity(params.get("severity"));
    const input: GetDataQualityInput = {
      scopeId,
      limit: parsePositiveLimit(params.get("limit"), {
        defaultLimit: DEFAULT_DATA_QUALITY_LIMIT,
        maxLimit: MAX_DATA_QUALITY_LIMIT,
      }),
      ...(category === undefined ? {} : { category }),
      ...(severity === undefined ? {} : { severity }),
      ...(params.get("cursor") ? { cursor: params.get("cursor")! } : {}),
    };

    return await runWithStore((store) =>
      catalogPagedJson(
        request,
        runCatalogRead(catalog.get_data_quality, input, store.agentView),
      ),
    );
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
    const input: GetTrashSummaryInput = {
      scopeId,
      limit: parsePositiveLimit(params.get("limit"), {
        defaultLimit: DEFAULT_TRASH_LIMIT,
        maxLimit: MAX_TRASH_LIMIT,
      }),
      ...(params.get("cursor") ? { cursor: params.get("cursor")! } : {}),
    };

    return await runWithStore((store) =>
      catalogPagedJson(
        request,
        runCatalogRead(catalog.get_trash_summary, input, store.agentView),
      ),
    );
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

    return await runWithStore((store) =>
      catalogJson(
        runCatalogRead(catalog.get_holding_detail, { holdingId }, store.agentView),
      ),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleGetPriceFreshness(
  request: NextRequest,
  holdingId: string,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, []);

    return await runWithStore((store) =>
      catalogJson(
        runCatalogRead(catalog.get_price_freshness, { holdingId }, store.agentView),
      ),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleListConnectedSources(
  request: NextRequest,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, []);

    return await runWithStore((store) =>
      catalogJson(runCatalogRead(catalog.list_connected_sources, {}, store.agentView)),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleGetSourceFreshness(
  request: NextRequest,
  sourceId: string,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, []);

    return await runWithStore((store) =>
      catalogJson(
        runCatalogRead(catalog.get_source_freshness, { sourceId }, store.agentView),
      ),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleGetWorkspace(
  request: NextRequest,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, []);

    return await runWithStore((store) =>
      catalogJson(runCatalogRead(catalog.get_workspace, {}, store.agentView)),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleGetWarningOverrides(
  request: NextRequest,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, []);

    return await runWithStore((store) =>
      catalogJson(runCatalogRead(catalog.get_warning_overrides, {}, store.agentView)),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleGetMemberProfiles(
  request: NextRequest,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, []);

    return await runWithStore((store) =>
      catalogJson(runCatalogRead(catalog.get_member_profile, {}, store.agentView)),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleListGoals(
  request: NextRequest,
  scopeId: string,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, []);

    return await runWithStore((store) =>
      catalogJson(runCatalogRead(catalog.list_goals, { scopeId }, store.agentView)),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleGetFireProjection(
  request: NextRequest,
  scopeId: string,
  runWithStore: StoreRunner,
): Promise<NextResponse> {
  try {
    guardAgentViewRequest(request, []);

    return await runWithStore((store) =>
      catalogJson(
        runCatalogRead(catalog.get_fire_projection, { scopeId }, store.agentView),
      ),
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
    const from = parseIsoDate(params.get("from"), "from");
    const to = parseIsoDate(params.get("to"), "to");
    const input: GetOperationsInput = {
      holdingId,
      limit: parsePositiveLimit(params.get("limit"), {
        defaultLimit: DEFAULT_OPERATION_LIMIT,
        maxLimit: MAX_OPERATION_LIMIT,
      }),
      sort: parseOperationSort(params.get("sort")),
      ...(params.get("cursor") ? { cursor: params.get("cursor")! } : {}),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    };

    return await runWithStore((store) =>
      catalogPagedJson(
        request,
        runCatalogRead(catalog.get_operations, input, store.agentView),
      ),
    );
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
    const input: GetConnectedSourcePositionsInput = {
      holdingId,
      limit: parsePositiveLimit(params.get("limit"), {
        defaultLimit: DEFAULT_POSITION_LIMIT,
        maxLimit: MAX_POSITION_LIMIT,
      }),
      ...(params.get("cursor") ? { cursor: params.get("cursor")! } : {}),
    };

    return await runWithStore((store) =>
      catalogPagedJson(
        request,
        runCatalogRead(catalog.get_connected_source_positions, input, store.agentView),
      ),
    );
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
    const input: GetConnectedSourcePositionsInput = {
      sourceId,
      limit: parsePositiveLimit(params.get("limit"), {
        defaultLimit: DEFAULT_POSITION_LIMIT,
        maxLimit: MAX_POSITION_LIMIT,
      }),
      ...(params.get("cursor") ? { cursor: params.get("cursor")! } : {}),
    };

    return await runWithStore((store) =>
      catalogPagedJson(
        request,
        runCatalogRead(catalog.get_connected_source_positions, input, store.agentView),
      ),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

async function catalogJson(
  resultPromise: Promise<AgentViewEnvelope<unknown> | AgentViewErrorEnvelope>,
): Promise<NextResponse> {
  const result = await resultPromise;
  if (isAgentViewErrorEnvelope(result)) {
    return json(result, catalogErrorStatus(result.error.code));
  }
  return json(result, 200);
}

async function catalogPagedJson(
  request: NextRequest,
  resultPromise: Promise<AgentViewEnvelope<unknown> | AgentViewErrorEnvelope>,
): Promise<NextResponse> {
  const result = await resultPromise;
  if (isAgentViewErrorEnvelope(result)) {
    return json(result, catalogErrorStatus(result.error.code));
  }
  return json(
    pagedHttpEnvelope(
      request,
      result.data,
      result.meta as unknown as AgentViewPaginationMeta,
    ),
    200,
  );
}

function catalogErrorStatus(code: AgentViewErrorEnvelope["error"]["code"]): number {
  switch (code) {
    case "bad_request":
      return 400;
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
    case "empty_workspace":
      return 404;
    case "unprocessable_entity":
      return 422;
    default:
      return 500;
  }
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
