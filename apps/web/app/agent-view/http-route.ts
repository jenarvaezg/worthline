import { type WorthlineStore } from "@worthline/db";
import { type NextRequest, NextResponse } from "next/server";

import { type AgentViewCatalogTool } from "./catalog";
import {
  type AgentViewEnvelope,
  type AgentViewErrorEnvelope,
  AgentViewHttpError,
  type AgentViewPaginationMeta,
  errorEnvelope,
} from "./contract";
import { guardAgentViewRequest } from "./http-guard";
import { pagedHttpEnvelope } from "./pagination";
import { isAgentViewErrorEnvelope, runCatalogRead } from "./read-backend";

/** Runs one read against a per-request store, then closes it. */
export type StoreRunner = <T>(
  run: (store: WorthlineStore) => T | Promise<T>,
) => Promise<T>;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

/** The positional path segments a route hands its handler, as a tuple of strings. */
type PathArgs<Names extends readonly string[]> = { [Index in keyof Names]: string };

/** The same path segments, keyed by name, as the spec's `input` reads them. */
type PathValues<Names extends readonly string[]> = { [Name in Names[number]]: string };

/**
 * A read endpoint's handler: the request, then its path segments in route order,
 * then the store runner. Route files call it exactly as before.
 */
export type AgentViewRouteHandler<Names extends readonly string[]> = (
  request: NextRequest,
  ...rest: [...PathArgs<Names>, StoreRunner]
) => Promise<NextResponse>;

/** Everything one agent-view read endpoint declares about itself. */
export interface AgentViewRouteSpec<Names extends readonly string[], Input> {
  /** Path segment names, in the order the Next route passes them. */
  pathParams: Names;
  /** The ONLY query params this endpoint accepts; anything else is a `400`. */
  allowedParams?: readonly string[];
  /** The catalog tool this endpoint dispatches to — the single source of truth. */
  tool: AgentViewCatalogTool<Input, AgentViewEnvelope<unknown> | AgentViewErrorEnvelope>;
  /**
   * Build the tool input from the path segments and the (already guarded) query
   * params. Any param rejection throws an {@link AgentViewHttpError} from here.
   */
  input: (path: PathValues<Names>, params: URLSearchParams) => Input;
  /** `true` when the tool returns a page, so the response carries pagination links. */
  paged?: boolean;
}

/**
 * Declare one agent-view read endpoint (#1695). The guard, the query-param
 * allowlist, the store run, the envelope and the `catch → toErrorResponse` tail
 * live HERE, once: the 22 endpoints are a table of specs, and a new one cannot
 * be written without its guard or its catch because there is nowhere to put a
 * handler body that skips them.
 */
export function defineAgentViewRoute<const Names extends readonly string[], Input>(
  spec: AgentViewRouteSpec<Names, Input>,
): AgentViewRouteHandler<Names> {
  return (async (request: NextRequest, ...rest: unknown[]): Promise<NextResponse> => {
    const runWithStore = rest[rest.length - 1] as StoreRunner;

    try {
      guardAgentViewRequest(request, spec.allowedParams ?? []);

      const url = new URL(request.url);
      const path = Object.fromEntries(
        spec.pathParams.map((name, index) => [name, rest[index] as string]),
      ) as PathValues<Names>;
      const input = spec.input(path, url.searchParams);

      return await runWithStore(async (store) => {
        const result = await runCatalogRead(spec.tool, input, store.agentView);
        return spec.paged === true
          ? pagedJson(request, result)
          : json(result, resultStatus(result));
      });
    } catch (error) {
      return toErrorResponse(error);
    }
  }) as AgentViewRouteHandler<Names>;
}

function pagedJson(
  request: NextRequest,
  result: AgentViewEnvelope<unknown> | AgentViewErrorEnvelope,
): NextResponse {
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

function resultStatus(
  result: AgentViewEnvelope<unknown> | AgentViewErrorEnvelope,
): number {
  return isAgentViewErrorEnvelope(result) ? catalogErrorStatus(result.error.code) : 200;
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
