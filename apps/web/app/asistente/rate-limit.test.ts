import { describe, expect, it } from "vitest";

import type { StoreTarget } from "@web/store-resolver";

import { CHAT_RATE_LIMITS, chatRatePlan, chatRateWindow } from "./rate-limit";

const AUTH_TARGET: StoreTarget = {
  kind: "authenticated",
  workspaceId: "wl-abc123",
  dbUrl: "libsql://x",
  token: "t",
};

describe("chatRateWindow", () => {
  it("buckets an ISO timestamp into its UTC hour", () => {
    expect(chatRateWindow("2026-07-04T10:59:59.999Z")).toBe("2026-07-04T10");
    expect(chatRateWindow("2026-07-04T11:00:00.000Z")).toBe("2026-07-04T11");
  });
});

describe("chatRatePlan", () => {
  it("keys authenticated requests by workspace with the workspace limit", () => {
    const plan = chatRatePlan(AUTH_TARGET, "1.2.3.4");
    expect(plan).toEqual({
      mode: "count",
      key: "ws:wl-abc123",
      limit: CHAT_RATE_LIMITS.workspace,
    });
  });

  it("keys demo requests by IP with the coarse limit", () => {
    const plan = chatRatePlan(
      { kind: "demo", persona: "inversor", now: "2026-07-04" },
      "1.2.3.4",
    );
    expect(plan).toEqual({
      mode: "count",
      key: "demo:1.2.3.4",
      limit: CHAT_RATE_LIMITS.coarse,
    });
  });

  it("falls back to a shared bucket when no IP is available", () => {
    const plan = chatRatePlan({ kind: "unauthenticated" }, null);
    expect(plan).toEqual({
      mode: "count",
      key: "ip:unknown",
      limit: CHAT_RATE_LIMITS.coarse,
    });
  });

  it("bypasses metering for the local single-user target", () => {
    expect(chatRatePlan({ kind: "local" }, "1.2.3.4")).toEqual({ mode: "bypass" });
  });

  it("workspace limit is more generous than the coarse fallback", () => {
    expect(CHAT_RATE_LIMITS.workspace).toBeGreaterThan(CHAT_RATE_LIMITS.coarse);
  });
});
