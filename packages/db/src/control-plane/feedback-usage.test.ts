import { createInMemoryControlPlaneStore, type UsageLimits } from "@db/control-plane";
import { describe, expect, it } from "vitest";

type UsageLimitsStore = UsageLimits & { close(): void };

describe("control plane feedback counter (#1174)", () => {
  it("increments within the same key and window", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    expect(await store.recordFeedbackSubmission("ws:a", "2026-10-11T10")).toBe(1);
    expect(await store.recordFeedbackSubmission("ws:a", "2026-10-11T10")).toBe(2);

    store.close();
  });

  it("hands every concurrent caller a distinct count, so a limit holds under a race", async () => {
    // The gate compares the RETURNED count against its limit. If two concurrent sends
    // could both read the same running total, both would pass at the boundary; the
    // single upsert-returning statement is what rules that out.
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    const counts = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.recordFeedbackSubmission("ws:a", "2026-10-11T10"),
      ),
    );

    expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    store.close();
  });

  it("counts keys and windows independently, and apart from the other meters", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordFeedbackSubmission("ws:a", "2026-10-11T10");
    await store.recordChatRequest("ws:a", "2026-10-11T10");

    expect(await store.recordFeedbackSubmission("ws:b", "2026-10-11T10")).toBe(1);
    expect(await store.recordFeedbackSubmission("ws:a", "2026-10-11T11")).toBe(1);
    expect(await store.recordFeedbackSubmission("ws:a", "2026-10-11T10")).toBe(2);

    store.close();
  });
});
