import type { StoreTarget } from "@web/store-resolver";
import { describe, expect, it } from "vitest";

import {
  isGlobalVisionCallFuseBlown,
  isVisionCallBudgetExhausted,
  VISION_CALL_LIMITS,
  visionCallDayWindow,
  visionCallPlan,
} from "./vision-call-budget";

const AUTH_TARGET: StoreTarget = {
  kind: "authenticated",
  workspaceId: "wl-1",
  dbUrl: "libsql://x",
  token: "t",
};
const DEMO_TARGET: StoreTarget = {
  kind: "demo",
  persona: "inversor",
  now: "2026-07-28",
};

describe("visionCallDayWindow", () => {
  it("buckets by UTC calendar day, like the token meter", () => {
    expect(visionCallDayWindow("2026-07-28T23:59:59.999Z")).toBe("2026-07-28");
    expect(visionCallDayWindow("2026-07-29T00:00:00.000Z")).toBe("2026-07-29");
  });
});

describe("visionCallPlan", () => {
  it("counts an authenticated workspace against its own daily allowance", () => {
    expect(visionCallPlan(AUTH_TARGET, "203.0.113.7")).toEqual({
      mode: "count",
      scopeKey: "ws:wl-1",
      dailyLimit: VISION_CALL_LIMITS.workspace,
    });
  });

  it("counts a demo visitor by IP — the hole #1258 named", () => {
    // demo resolves to `premium`, so the ingestion paywall never fires for it and
    // an anonymous caller reaches the vision model. The IP scope is the only thing
    // between that caller and a bill.
    expect(visionCallPlan(DEMO_TARGET, "203.0.113.7")).toEqual({
      mode: "count",
      scopeKey: "demo:203.0.113.7",
      dailyLimit: VISION_CALL_LIMITS.demo,
    });
  });

  it("still counts a demo visitor whose IP the platform did not give us", () => {
    // One shared bucket rather than no bucket: an unknown IP must not be the way
    // out of the counter.
    expect(visionCallPlan(DEMO_TARGET, null)).toEqual({
      mode: "count",
      scopeKey: "demo:unknown",
      dailyLimit: VISION_CALL_LIMITS.demo,
    });
  });

  it("counts an unauthenticated caller by IP", () => {
    // The route answers 401 long before this, but the plan is total: a scope that
    // returned `bypass` here would become a hole the day another caller appears.
    expect(visionCallPlan({ kind: "unauthenticated" }, "203.0.113.7")).toEqual({
      mode: "count",
      scopeKey: "ip:203.0.113.7",
      dailyLimit: VISION_CALL_LIMITS.demo,
    });
  });

  it("bypasses the local single-user target, where the developer owns the key", () => {
    expect(visionCallPlan({ kind: "local" }, null)).toEqual({ mode: "bypass" });
  });
});

describe("isVisionCallBudgetExhausted", () => {
  it("refuses once the recorded readings reach the allowance", () => {
    expect(isVisionCallBudgetExhausted(59, 60)).toBe(false);
    expect(isVisionCallBudgetExhausted(60, 60)).toBe(true);
    expect(isVisionCallBudgetExhausted(61, 60)).toBe(true);
  });

  it("lets an untouched scope through", () => {
    expect(isVisionCallBudgetExhausted(0, VISION_CALL_LIMITS.workspace)).toBe(false);
  });
});

describe("isGlobalVisionCallFuseBlown", () => {
  it("blows once the shared daily total reaches the fuse", () => {
    expect(isGlobalVisionCallFuseBlown(VISION_CALL_LIMITS.global - 1)).toBe(false);
    expect(isGlobalVisionCallFuseBlown(VISION_CALL_LIMITS.global)).toBe(true);
  });
});

describe("the limits themselves", () => {
  it("leaves the demo allowance well below the workspace one, and both below the fuse", () => {
    // The shape matters more than the figures: an anonymous visitor gets less rope
    // than a paying workspace, and no single scope can blow the shared fuse alone.
    expect(VISION_CALL_LIMITS.demo).toBeLessThan(VISION_CALL_LIMITS.workspace);
    expect(VISION_CALL_LIMITS.workspace).toBeLessThan(VISION_CALL_LIMITS.global);
  });
});
