import { describe, expect, it } from "vitest";

import { createInMemoryControlPlaneStore, type UsageLimits } from "./control-plane";

// Cross the real UsageLimits port seam: the attachment extraction meter (#1258)
// counts vision READINGS — model calls, not tokens — per scope per UTC day. It is
// deliberately a second counter next to the AI token meter (#1163): that one means
// «the conversational turn, the recurring cost», and the eager extractors are a
// one-shot ingestion cost the token semantics never covered. Each recorded reading
// feeds BOTH its own scope counter (a workspace, or a demo IP) and the shared global
// fuse. Aggregate only — the table has no column for content.
type UsageLimitsStore = UsageLimits & { close(): void };

describe("control plane vision extraction meter", () => {
  it("accumulates a scope's and the global total together", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordVisionCalls("ws:ws-a", "2026-07-28", 2);
    await store.recordVisionCalls("ws:ws-a", "2026-07-28", 1);

    expect(await store.readVisionCallUsage("ws:ws-a", "2026-07-28")).toEqual({
      scopeCalls: 3,
      globalCalls: 3,
    });

    store.close();
  });

  it("keeps scopes separate but sums every one of them into the shared fuse", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordVisionCalls("ws:ws-a", "2026-07-28", 2);
    // A demo visitor is a scope too — that is the hole #1258 opened: demo resolves
    // to premium, so an anonymous caller reaches the extractor with no plan gate.
    await store.recordVisionCalls("demo:203.0.113.7", "2026-07-28", 4);

    expect(await store.readVisionCallUsage("ws:ws-a", "2026-07-28")).toEqual({
      scopeCalls: 2,
      globalCalls: 6,
    });
    expect(await store.readVisionCallUsage("demo:203.0.113.7", "2026-07-28")).toEqual({
      scopeCalls: 4,
      globalCalls: 6,
    });

    store.close();
  });

  it("buckets by UTC day and reads zero for a day with no readings", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordVisionCalls("ws:ws-a", "2026-07-28", 2);

    expect(await store.readVisionCallUsage("ws:ws-a", "2026-07-29")).toEqual({
      scopeCalls: 0,
      globalCalls: 0,
    });

    store.close();
  });

  it("ignores non-positive call deltas", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    // A spreadsheet pays for no vision call at all, and the route records what the
    // reading reports — so zero must not create a row or bump the fuse.
    await store.recordVisionCalls("ws:ws-a", "2026-07-28", 0);
    await store.recordVisionCalls("ws:ws-a", "2026-07-28", -3);

    expect(await store.readVisionCallUsage("ws:ws-a", "2026-07-28")).toEqual({
      scopeCalls: 0,
      globalCalls: 0,
    });

    store.close();
  });

  it("does not double-count when a caller passes the global scope key itself", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    // The policy module never mints "global", but the port is the boundary: a
    // caller that did would otherwise add its calls to the fuse twice and blow it
    // at half the real usage.
    await store.recordVisionCalls("global", "2026-07-28", 5);

    expect(await store.readVisionCallUsage("global", "2026-07-28")).toEqual({
      scopeCalls: 5,
      globalCalls: 5,
    });

    store.close();
  });

  it("reads the global daily series for /admin, newest first", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordVisionCalls("ws:ws-a", "2026-07-26", 1);
    await store.recordVisionCalls("ws:ws-b", "2026-07-28", 2);
    await store.recordVisionCalls("demo:203.0.113.7", "2026-07-28", 3);

    expect(await store.readRecentGlobalVisionCallUsage("2026-07-27")).toEqual([
      { dayKey: "2026-07-28", calls: 5 },
    ]);
    expect(await store.readRecentGlobalVisionCallUsage("2026-07-26")).toEqual([
      { dayKey: "2026-07-28", calls: 5 },
      { dayKey: "2026-07-26", calls: 1 },
    ]);

    store.close();
  });
});
