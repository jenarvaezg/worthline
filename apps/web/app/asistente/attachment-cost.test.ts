import type { StoreTarget } from "@web/store-resolver";
import { describe, expect, it } from "vitest";

import {
  isVisionCallBudgetSpent,
  VISION_BUDGET_SPENT_FAILURE,
  VISION_CALL_LIMITS,
  visionCallBuckets,
  visionCallWindow,
} from "./attachment-cost";

const authenticated: StoreTarget = {
  kind: "authenticated",
  workspaceId: "wl-1",
  dbUrl: "libsql://x",
  token: "t",
};
const demo: StoreTarget = { kind: "demo", persona: "familia", now: "2026-07-27" };

describe("visionCallBuckets", () => {
  it("leaves the local single-user target unmetered", () => {
    expect(visionCallBuckets({ kind: "local" }, null)).toEqual([]);
  });

  it("keys an authenticated caller by workspace", () => {
    expect(visionCallBuckets(authenticated, "1.2.3.4")).toEqual([
      { key: "ws:wl-1", limit: VISION_CALL_LIMITS.workspace, scope: "workspace" },
    ]);
  });

  it("charges demo to its own IP and to the shared demo bucket", () => {
    expect(visionCallBuckets(demo, "1.2.3.4")).toEqual([
      { key: "demo:1.2.3.4", limit: VISION_CALL_LIMITS.demo, scope: "demo-ip" },
      { key: "demo:global", limit: VISION_CALL_LIMITS.demoGlobal, scope: "demo-global" },
    ]);
  });

  it("carries a scope so a log can name the bucket without naming the IP", () => {
    // The key is `demo:<ip>`: personal data that must not reach a log line (#1131).
    expect(visionCallBuckets(demo, "1.2.3.4").map((bucket) => bucket.scope)).toEqual([
      "demo-ip",
      "demo-global",
    ]);
  });

  it("still keys a demo caller behind an unknown IP", () => {
    expect(visionCallBuckets(demo, null)[0]?.key).toBe("demo:unknown");
  });

  it("keeps demo ceilings well below the authenticated one", () => {
    // Anonymous, free and unidentifiable: the surface #1258 flagged first.
    expect(VISION_CALL_LIMITS.demo).toBeLessThan(VISION_CALL_LIMITS.workspace);
    expect(VISION_CALL_LIMITS.demoGlobal).toBeGreaterThan(VISION_CALL_LIMITS.demo);
  });
});

describe("visionCallWindow", () => {
  it("buckets by fixed UTC hour", () => {
    expect(visionCallWindow("2026-07-27T10:41:09.000Z")).toBe("2026-07-27T10");
  });
});

describe("isVisionCallBudgetSpent", () => {
  const buckets = visionCallBuckets(demo, "1.2.3.4");

  it("lets a caller under every ceiling read", () => {
    expect(
      isVisionCallBudgetSpent(buckets, {
        "demo:1.2.3.4": VISION_CALL_LIMITS.demo - 1,
        "demo:global": VISION_CALL_LIMITS.demoGlobal - 1,
      }),
    ).toBe(false);
  });

  it("blows on the caller's own ceiling", () => {
    expect(
      isVisionCallBudgetSpent(buckets, { "demo:1.2.3.4": VISION_CALL_LIMITS.demo }),
    ).toBe(true);
  });

  it("blows on the shared ceiling even when this IP has barely read", () => {
    // A botnet cannot multiply the per-IP ceiling (#1184's shape, applied to money).
    expect(
      isVisionCallBudgetSpent(buckets, {
        "demo:1.2.3.4": 1,
        "demo:global": VISION_CALL_LIMITS.demoGlobal,
      }),
    ).toBe(true);
  });

  it("treats a key with no row as zero rather than as spent", () => {
    expect(isVisionCallBudgetSpent(buckets, {})).toBe(false);
  });

  it("never blows for a caller with no buckets", () => {
    expect(isVisionCallBudgetSpent([], { "ws:whoever": 999 })).toBe(false);
  });
});

describe("VISION_BUDGET_SPENT_FAILURE", () => {
  it("is transient, so the card never reads as a permanent refusal", () => {
    expect(VISION_BUDGET_SPENT_FAILURE.failure).toBe("transient");
    expect(VISION_BUDGET_SPENT_FAILURE.code).toBe("extractor_budget_spent");
  });
});
