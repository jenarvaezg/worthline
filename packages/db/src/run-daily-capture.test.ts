import { describe, expect, test, vi } from "vitest";

import { createInMemoryStore } from "@db/index";
import { runDailyCapture } from "@db/run-daily-capture";
import type { WorthlineStore } from "@db/store-types";

const NOW = "2026-06-25T21:00:00.000Z";
const TODAY = "2026-06-25";

/** A seeded, single-member workspace — capture writes a (zero-value) snapshot. */
async function seededStore(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

/**
 * `runDailyCapture` closes every store it opens; wrap so the test can still read
 * the persisted snapshots afterwards. The real store is closed at test end.
 */
function keepOpen(store: WorthlineStore): WorthlineStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "close") return () => {};
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe("runDailyCapture (ADR 0037, PRD #528)", () => {
  test("captures a snapshot for every workspace at the run's date", async () => {
    const a = await seededStore();
    const b = await seededStore();
    const fetchPrices = vi.fn(async () => {});

    const result = await runDailyCapture({
      listAllWorkspaces: async () => [
        { id: "wsA", dbUrl: "libsql://a" },
        { id: "wsB", dbUrl: "libsql://b" },
      ],
      openStore: async (ws) => keepOpen(ws.id === "wsA" ? a : b),
      fetchPrices,
      now: NOW,
    });

    expect(result).toMatchObject({ total: 2, captured: 2, failures: [] });
    expect(fetchPrices).toHaveBeenCalledTimes(2);

    for (const store of [a, b]) {
      const snaps = await store.snapshots.readSnapshots("household");
      expect(snaps).toHaveLength(1);
      expect(snaps[0]!.dateKey).toBe(TODAY);
      store.close();
    }
  });

  test("a workspace that fails to open does not block the others (isolation)", async () => {
    const good = await seededStore();

    const result = await runDailyCapture({
      listAllWorkspaces: async () => [
        { id: "bad", dbUrl: "libsql://bad" },
        { id: "good", dbUrl: "libsql://good" },
      ],
      openStore: async (ws) => {
        if (ws.id === "bad") throw new Error("unreachable workspace DB");
        return keepOpen(good);
      },
      fetchPrices: async () => {},
      now: NOW,
    });

    expect(result.captured).toBe(1);
    expect(result.failures).toEqual([
      { workspaceId: "bad", error: expect.stringContaining("unreachable") },
    ]);
    expect(await good.snapshots.readSnapshots("household")).toHaveLength(1);
    good.close();
  });

  test("capture is unconditional: a same-day point is overridden, never duplicated", async () => {
    const store = await seededStore();
    const deps = {
      listAllWorkspaces: async () => [{ id: "ws", dbUrl: "libsql://ws" }],
      openStore: async () => keepOpen(store),
      fetchPrices: async () => {},
    };

    // A morning render-style provisional point.
    await runDailyCapture({ ...deps, now: "2026-06-25T08:00:00.000Z" });
    const morning = await store.snapshots.readSnapshots("household");
    expect(morning).toHaveLength(1);
    expect(morning[0]!.capturedAt).toBe("2026-06-25T08:00:00.000Z");

    // The close-of-day run overrides it (latest-wins), no duplicate.
    await runDailyCapture({ ...deps, now: NOW });
    const close = await store.snapshots.readSnapshots("household");
    expect(close).toHaveLength(1);
    expect(close[0]!.dateKey).toBe(TODAY);
    expect(close[0]!.capturedAt).toBe(NOW);

    store.close();
  });
});
