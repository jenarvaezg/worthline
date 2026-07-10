import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";

import { AgentViewHttpError } from "./contract";
import { clampPositiveLimit, pagedHttpEnvelope, parsePositiveLimit } from "./pagination";

describe("parsePositiveLimit", () => {
  const options = { defaultLimit: 100, maxLimit: 500 };

  test("returns the default when the query param is absent", () => {
    expect(parsePositiveLimit(null, options)).toBe(100);
  });

  test("accepts a valid limit within the maximum", () => {
    expect(parsePositiveLimit("25", options)).toBe(25);
  });

  test("clamps a limit over the documented maximum", () => {
    expect(parsePositiveLimit("9999", options)).toBe(500);
  });

  test("rejects zero and non-numeric limits", () => {
    for (const raw of ["0", "abc", "-1", "1.5"]) {
      expect(() => parsePositiveLimit(raw, options)).toThrow(AgentViewHttpError);
      try {
        parsePositiveLimit(raw, options);
      } catch (error) {
        expect(error).toMatchObject({
          code: "bad_request",
          message: "limit must be a positive integer.",
          status: 400,
          details: { limit: raw },
        });
      }
    }
  });

  test("preserves each endpoint default and maximum", () => {
    expect(parsePositiveLimit(null, { defaultLimit: 25, maxLimit: 100 })).toBe(25);
    expect(parsePositiveLimit("150", { defaultLimit: 25, maxLimit: 100 })).toBe(100);
  });
});

describe("clampPositiveLimit", () => {
  const options = { defaultLimit: 100, maxLimit: 500 };

  test("defaults invalid limits when onInvalid is default", () => {
    expect(clampPositiveLimit(undefined, options)).toBe(100);
    expect(clampPositiveLimit(0, options)).toBe(100);
    expect(clampPositiveLimit(9999, options)).toBe(500);
  });

  test("rejects invalid limits when onInvalid is reject", () => {
    expect(() => clampPositiveLimit(0, { ...options, onInvalid: "reject" })).toThrow(
      AgentViewHttpError,
    );
  });
});

describe("pagedHttpEnvelope", () => {
  test("builds self and next links from the request URL and next cursor", () => {
    const request = new NextRequest(
      "http://127.0.0.1/api/v1/agent-view/scopes/wl_scp_home/snapshots?limit=2&granularity=raw",
    );

    const envelope = pagedHttpEnvelope(request, [{ id: "a" }], {
      hasNext: true,
      limit: 2,
      nextCursor: "2024-01-01:wl_snap_abc",
    });

    expect(envelope).toEqual({
      data: [{ id: "a" }],
      links: {
        self: "/api/v1/agent-view/scopes/wl_scp_home/snapshots?limit=2&granularity=raw",
        next: "/api/v1/agent-view/scopes/wl_scp_home/snapshots?limit=2&granularity=raw&cursor=2024-01-01%3Awl_snap_abc",
      },
      meta: {
        hasNext: true,
        limit: 2,
        nextCursor: "2024-01-01:wl_snap_abc",
      },
    });
  });

  test("omits next when there is no next cursor", () => {
    const request = new NextRequest(
      "http://127.0.0.1/api/v1/agent-view/scopes/wl_scp_home/trash-summary",
    );

    const envelope = pagedHttpEnvelope(request, [], {
      hasNext: false,
      limit: 100,
    });

    expect(envelope.links).toEqual({
      self: "/api/v1/agent-view/scopes/wl_scp_home/trash-summary",
    });
  });
});
