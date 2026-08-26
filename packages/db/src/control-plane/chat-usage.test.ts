import { createInMemoryControlPlaneStore, type UsageLimits } from "@db/control-plane";
import { describe, expect, it } from "vitest";

// Cross the real UsageLimits port seam: the in-memory store implements the whole
// control plane, but this test depends only on the usage-limits concern.
type UsageLimitsStore = UsageLimits & { close(): void };

describe("control plane chat usage counter", () => {
  it("increments atomically within the same key and window", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    expect(await store.recordChatRequest("ws:a", "2026-07-04T10")).toBe(1);
    expect(await store.recordChatRequest("ws:a", "2026-07-04T10")).toBe(2);
    expect(await store.recordChatRequest("ws:a", "2026-07-04T10")).toBe(3);

    store.close();
  });

  it("counts keys and windows independently", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordChatRequest("ws:a", "2026-07-04T10");
    await store.recordChatRequest("ws:a", "2026-07-04T10");

    expect(await store.recordChatRequest("ws:b", "2026-07-04T10")).toBe(1);
    expect(await store.recordChatRequest("ws:a", "2026-07-04T11")).toBe(1);

    store.close();
  });

  it("tracks the demo global bucket separately from per-IP demo buckets", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    expect(await store.recordChatRequest("demo:1.2.3.4", "2026-07-04T10")).toBe(1);
    expect(await store.recordChatRequest("demo:global", "2026-07-04T10")).toBe(1);
    expect(await store.recordChatRequest("demo:5.6.7.8", "2026-07-04T10")).toBe(1);
    expect(await store.recordChatRequest("demo:global", "2026-07-04T10")).toBe(2);

    store.close();
  });

  it("replenishes the demo global bucket in a new UTC hour window", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordChatRequest("demo:global", "2026-07-04T10");
    await store.recordChatRequest("demo:global", "2026-07-04T10");

    expect(await store.recordChatRequest("demo:global", "2026-07-04T11")).toBe(1);

    store.close();
  });
});
