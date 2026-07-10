import type { NextRequest } from "next/server";

import { AgentViewHttpError, type AgentViewPaginationMeta } from "./contract";

export interface ParsePositiveLimitOptions {
  defaultLimit: number;
  maxLimit: number;
}

export interface ClampPositiveLimitOptions {
  defaultLimit: number;
  maxLimit: number;
  /** `default` silently substitutes the default limit; `reject` throws on invalid input. */
  onInvalid?: "default" | "reject";
}

/** Clamp a numeric page size to the documented `[1, max]` contract. */
export function clampPositiveLimit(
  limit: number | undefined,
  options: ClampPositiveLimitOptions,
): number {
  if (limit === undefined) {
    return options.defaultLimit;
  }

  if (!Number.isInteger(limit) || limit < 1) {
    if (options.onInvalid === "reject") {
      throw new AgentViewHttpError({
        code: "bad_request",
        details: { limit },
        message: "limit must be a positive integer.",
        status: 400,
      });
    }
    return options.defaultLimit;
  }

  return Math.min(limit, options.maxLimit);
}

/** Parse a query `limit`: positive integer, clamped to the documented max. */
export function parsePositiveLimit(
  raw: string | null,
  options: ParsePositiveLimitOptions,
): number {
  if (raw === null) {
    return options.defaultLimit;
  }

  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { limit: raw },
      message: "limit must be a positive integer.",
      status: 400,
    });
  }

  return Math.min(Number(raw), options.maxLimit);
}

/**
 * Envelope a paged agent-view collection: `data` as the page rows, pagination
 * facts as `meta`, and `links.self` plus `links.next` (same URL with `cursor`)
 * when more pages remain.
 */
export function pagedHttpEnvelope<T>(
  request: NextRequest,
  data: T,
  meta: AgentViewPaginationMeta,
) {
  const self = new URL(request.url);
  const links: Record<string, string> = { self: self.pathname + self.search };

  if (meta.nextCursor !== undefined) {
    const next = new URL(request.url);
    next.searchParams.set("cursor", meta.nextCursor);
    links.next = next.pathname + next.search;
  }

  return { data, links, meta };
}
