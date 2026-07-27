import { describe, expect, it } from "vitest";

import { createInMemoryControlPlaneStore, type UsageLimits } from "./control-plane";

// Cross the real UsageLimits port seam: the in-memory store implements the whole
// control plane, but this test depends only on the usage-limits concern.
type UsageLimitsStore = UsageLimits & { close(): void };

describe("control plane attachment extraction counter", () => {
  it("reads zero before anything is recorded", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    expect(await store.readAttachmentExtractionCalls("ws:a", "2026-07-27T10")).toBe(0);

    store.close();
  });

  it("accumulates calls within the same key and window", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    // One attachment identified in a single call, then one that also paid for a
    // descriptive reading (#1246): three calls, not two attachments.
    await store.recordAttachmentExtractionCalls("ws:a", "2026-07-27T10", 1);
    await store.recordAttachmentExtractionCalls("ws:a", "2026-07-27T10", 2);

    expect(await store.readAttachmentExtractionCalls("ws:a", "2026-07-27T10")).toBe(3);

    store.close();
  });

  it("counts keys and windows independently", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordAttachmentExtractionCalls("ws:a", "2026-07-27T10", 2);

    expect(await store.readAttachmentExtractionCalls("ws:b", "2026-07-27T10")).toBe(0);
    expect(await store.readAttachmentExtractionCalls("ws:a", "2026-07-27T11")).toBe(0);

    store.close();
  });

  it("ignores a reading that paid for no model call at all", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordAttachmentExtractionCalls("ws:a", "2026-07-27T10", 0);

    expect(await store.readAttachmentExtractionCalls("ws:a", "2026-07-27T10")).toBe(0);

    store.close();
  });

  it("keeps the extraction counter apart from the chat rate counter", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordChatRequest("ws:a", "2026-07-27T10");
    await store.recordChatRequest("ws:a", "2026-07-27T10");

    expect(await store.readAttachmentExtractionCalls("ws:a", "2026-07-27T10")).toBe(0);

    store.close();
  });
});
