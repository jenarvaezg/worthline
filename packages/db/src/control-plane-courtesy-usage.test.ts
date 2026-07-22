import { describe, expect, it } from "vitest";

import { createInMemoryControlPlaneStore, type UsageLimits } from "./control-plane";

// Cross the real UsageLimits port seam: the monthly courtesy counter (PRD #1160
// S2, #1162) lives in its own table so it cannot interfere with the hourly chat
// rate limit (ADR 0051) — the free assistant's product quota is a distinct
// concern from the operational throttle on the shared key.
type UsageLimitsStore = UsageLimits & { close(): void };

describe("control plane assistant courtesy usage counter", () => {
  it("increments atomically within the same key and window", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    expect(await store.recordAssistantCourtesyUse("ws:a", "2026-07")).toBe(1);
    expect(await store.recordAssistantCourtesyUse("ws:a", "2026-07")).toBe(2);
    expect(await store.recordAssistantCourtesyUse("ws:a", "2026-07")).toBe(3);

    store.close();
  });

  it("counts keys and months independently", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordAssistantCourtesyUse("ws:a", "2026-07");
    await store.recordAssistantCourtesyUse("ws:a", "2026-07");

    expect(await store.recordAssistantCourtesyUse("ws:b", "2026-07")).toBe(1);
    expect(await store.recordAssistantCourtesyUse("ws:a", "2026-08")).toBe(1);

    store.close();
  });

  it("does not share rows with the hourly chat counter", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordChatRequest("ws:a", "2026-07");
    expect(await store.recordAssistantCourtesyUse("ws:a", "2026-07")).toBe(1);

    store.close();
  });
});
