import { describe, expect, it } from "vitest";

import { createInMemoryControlPlaneStore } from "./control-plane";

describe("control plane chat usage counter", () => {
  it("increments atomically within the same key and window", async () => {
    const store = await createInMemoryControlPlaneStore();

    expect(await store.recordChatRequest("ws:a", "2026-07-04T10")).toBe(1);
    expect(await store.recordChatRequest("ws:a", "2026-07-04T10")).toBe(2);
    expect(await store.recordChatRequest("ws:a", "2026-07-04T10")).toBe(3);

    store.close();
  });

  it("counts keys and windows independently", async () => {
    const store = await createInMemoryControlPlaneStore();

    await store.recordChatRequest("ws:a", "2026-07-04T10");
    await store.recordChatRequest("ws:a", "2026-07-04T10");

    expect(await store.recordChatRequest("ws:b", "2026-07-04T10")).toBe(1);
    expect(await store.recordChatRequest("ws:a", "2026-07-04T11")).toBe(1);

    store.close();
  });
});
