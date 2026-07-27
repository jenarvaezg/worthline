import { CHAT_RATE_LIMITS } from "@web/asistente/rate-limit";
import { describe, expect, it } from "vitest";

import {
  authOAuthRatePlan,
  MCP_RATE_LIMITS,
  mcpPreAuthRatePlan,
  mcpRateWindow,
  mcpSubjectRatePlan,
} from "./rate-limit";

describe("mcpRateWindow", () => {
  it("buckets an ISO timestamp into its UTC hour", () => {
    expect(mcpRateWindow("2026-07-04T10:59:59.999Z")).toBe("2026-07-04T10");
    expect(mcpRateWindow("2026-07-04T11:00:00.000Z")).toBe("2026-07-04T11");
  });
});

describe("mcpPreAuthRatePlan", () => {
  it("keys pre-auth traffic by IP with the coarse limit", () => {
    expect(mcpPreAuthRatePlan("203.0.113.10")).toEqual({
      mode: "count",
      key: "mcp:ip:203.0.113.10",
      limit: MCP_RATE_LIMITS.coarse,
    });
  });

  it("falls back to a shared bucket when no IP is available", () => {
    expect(mcpPreAuthRatePlan(null)).toEqual({
      mode: "count",
      key: "mcp:ip:unknown",
      limit: MCP_RATE_LIMITS.coarse,
    });
  });
});

describe("mcpSubjectRatePlan", () => {
  it("keys post-JWT traffic by subject with the workspace-equivalent limit", () => {
    expect(mcpSubjectRatePlan("workos_user_ana")).toEqual({
      mode: "count",
      key: "mcp:sub:workos_user_ana",
      limit: MCP_RATE_LIMITS.subject,
    });
  });
});

describe("authOAuthRatePlan", () => {
  it("keys Auth.js callback traffic by IP in its own namespace", () => {
    expect(authOAuthRatePlan("203.0.113.20")).toEqual({
      mode: "count",
      key: "auth:ip:203.0.113.20",
      limit: MCP_RATE_LIMITS.coarse,
    });
  });
});

describe("MCP_RATE_LIMITS", () => {
  it("mirrors the chat workspace/coarse pair", () => {
    expect(MCP_RATE_LIMITS.subject).toBe(CHAT_RATE_LIMITS.workspace);
    expect(MCP_RATE_LIMITS.coarse).toBe(CHAT_RATE_LIMITS.coarse);
    expect(MCP_RATE_LIMITS.subject).toBeGreaterThan(MCP_RATE_LIMITS.coarse);
  });
});
