import { describe, expect, it } from "vitest";

import { createInMemoryControlPlaneStore, type UsageLimits } from "./control-plane";

// Cross the real UsageLimits port seam: the AI token meter (PRD #1160 S3, #1163)
// counts aggregate tokens per scope per UTC day. Each recorded turn feeds BOTH
// the workspace's own budget counter and the shared global fuse; the pre-call
// gate reads both, and /admin reads the global daily series. Aggregate only —
// the table has no column for content.
type UsageLimitsStore = UsageLimits & { close(): void };

describe("control plane AI token usage meter", () => {
  it("accumulates a workspace's and the global total together", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordAiTokenUsage("ws-a", "2026-07-22", 100);
    await store.recordAiTokenUsage("ws-a", "2026-07-22", 50);

    expect(await store.readAiTokenUsage("ws-a", "2026-07-22")).toEqual({
      workspaceTokens: 150,
      globalTokens: 150,
    });

    store.close();
  });

  it("keeps per-workspace budgets separate but sums into the shared fuse", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordAiTokenUsage("ws-a", "2026-07-22", 100);
    await store.recordAiTokenUsage("ws-b", "2026-07-22", 30);

    // Each workspace sees only its own usage; the global fuse sees both.
    expect(await store.readAiTokenUsage("ws-a", "2026-07-22")).toEqual({
      workspaceTokens: 100,
      globalTokens: 130,
    });
    expect(await store.readAiTokenUsage("ws-b", "2026-07-22")).toEqual({
      workspaceTokens: 30,
      globalTokens: 130,
    });

    store.close();
  });

  it("buckets by UTC day and reads zero for a day with no usage", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordAiTokenUsage("ws-a", "2026-07-22", 100);

    expect(await store.readAiTokenUsage("ws-a", "2026-07-23")).toEqual({
      workspaceTokens: 0,
      globalTokens: 0,
    });

    store.close();
  });

  it("ignores non-positive token deltas", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordAiTokenUsage("ws-a", "2026-07-22", 0);
    await store.recordAiTokenUsage("ws-a", "2026-07-22", -20);

    expect(await store.readAiTokenUsage("ws-a", "2026-07-22")).toEqual({
      workspaceTokens: 0,
      globalTokens: 0,
    });

    store.close();
  });

  it("exposes the global daily series for /admin, newest first, from a floor", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordAiTokenUsage("ws-a", "2026-07-20", 10);
    await store.recordAiTokenUsage("ws-b", "2026-07-21", 20);
    await store.recordAiTokenUsage("ws-a", "2026-07-22", 30);
    await store.recordAiTokenUsage("ws-b", "2026-07-22", 5);

    expect(await store.readRecentGlobalAiTokenUsage("2026-07-21")).toEqual([
      { dayKey: "2026-07-22", tokens: 35 },
      { dayKey: "2026-07-21", tokens: 20 },
    ]);

    store.close();
  });

  it("lists per-workspace usage for a day (never the global fuse) for /admin (#1164)", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordAiTokenUsage("ws-a", "2026-07-22", 30);
    await store.recordAiTokenUsage("ws-b", "2026-07-22", 5);
    await store.recordAiTokenUsage("ws-a", "2026-07-21", 99);

    const day = await store.listWorkspaceAiTokenUsage("2026-07-22");
    const byId = new Map(day.map((r) => [r.workspaceId, r.tokens]));

    // Only the two workspaces of that day, and never the 'global' scope row.
    expect(day).toHaveLength(2);
    expect(byId.get("ws-a")).toBe(30);
    expect(byId.get("ws-b")).toBe(5);
    expect(byId.has("global")).toBe(false);

    // A day with no usage is simply empty.
    expect(await store.listWorkspaceAiTokenUsage("2026-07-23")).toEqual([]);

    store.close();
  });
});
