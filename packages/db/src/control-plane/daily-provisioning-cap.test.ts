import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createControlPlaneStore,
  createInMemoryControlPlaneStore,
  type DailyProvisioningCap,
} from "@db/control-plane";
import { afterAll, describe, expect, it } from "vitest";

// Cross the real DailyProvisioningCap port seam: the in-memory store implements
// the whole control plane, but these tests depend only on the daily cap.
type CapStore = DailyProvisioningCap & { close(): void };

// Illustrative limits only — the real figure lives in the deployment's env.
const DAY = "2026-03-14";

/**
 * How many workspaces `day` has provisioned, read through the port itself: a
 * claim under a limit nothing reaches reports the count it lands on, and the
 * release hands that probe back. No test-only read on the production port.
 */
async function provisionedOn(store: CapStore, day: string): Promise<number> {
  const probe = await store.claimDailyProvisioning(day, Number.MAX_SAFE_INTEGER);
  await store.releaseDailyProvisioning(day);
  return probe.provisionedToday - 1;
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
});

describe("control plane daily provisioning cap (#1175)", () => {
  it("admits workspaces up to the limit and refuses the next one", async () => {
    const store: CapStore = await createInMemoryControlPlaneStore();
    try {
      expect(await store.claimDailyProvisioning(DAY, 2)).toEqual({
        admitted: true,
        provisionedToday: 1,
      });
      expect(await store.claimDailyProvisioning(DAY, 2)).toEqual({
        admitted: true,
        provisionedToday: 2,
      });
      expect(await store.claimDailyProvisioning(DAY, 2)).toEqual({
        admitted: false,
        provisionedToday: 2,
      });
      // A refusal writes nothing: the count stays at the limit.
      expect(await provisionedOn(store, DAY)).toBe(2);
    } finally {
      store.close();
    }
  });

  it("a limit of zero refuses without opening the day", async () => {
    const store: CapStore = await createInMemoryControlPlaneStore();
    try {
      expect(await store.claimDailyProvisioning(DAY, 0)).toEqual({
        admitted: false,
        provisionedToday: 0,
      });
      expect(await provisionedOn(store, DAY)).toBe(0);
    } finally {
      store.close();
    }
  });

  it("starts every UTC day from zero", async () => {
    const store: CapStore = await createInMemoryControlPlaneStore();
    try {
      await store.claimDailyProvisioning("2026-03-14", 1);
      expect(await store.claimDailyProvisioning("2026-03-14", 1)).toEqual({
        admitted: false,
        provisionedToday: 1,
      });

      expect(await store.claimDailyProvisioning("2026-03-15", 1)).toEqual({
        admitted: true,
        provisionedToday: 1,
      });
      // Yesterday's count is untouched by today's claim.
      expect(await provisionedOn(store, "2026-03-14")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("a release goes back to the day it was claimed on, never below zero", async () => {
    const store: CapStore = await createInMemoryControlPlaneStore();
    try {
      await store.claimDailyProvisioning(DAY, 1);
      await store.releaseDailyProvisioning(DAY);
      expect(await store.claimDailyProvisioning(DAY, 1)).toEqual({
        admitted: true,
        provisionedToday: 1,
      });

      // Releasing more than was claimed (or on a day with no row) is a no-op.
      await store.releaseDailyProvisioning(DAY);
      await store.releaseDailyProvisioning(DAY);
      await store.releaseDailyProvisioning("2026-03-01");
      expect(await provisionedOn(store, DAY)).toBe(0);
      expect(await provisionedOn(store, "2026-03-01")).toBe(0);
    } finally {
      store.close();
    }
  });

  it("claims interleaved across two connections to one database never exceed the limit", async () => {
    // Two control-plane connections over ONE database file — the shape of two
    // serverless instances sharing the hosted control plane. Honest about what
    // this exercises: libSQL's local client runs one statement at a time, so the
    // claims INTERLEAVE rather than run in parallel. What it pins is that the
    // check and the increment are a single statement — there is no read-then-
    // write window for a second instance to slip through — which is exactly the
    // guarantee SQLite (and Turso over HTTP) gives a statement.
    const dir = mkdtempSync(join(tmpdir(), "worthline-daily-provisioning-cap-"));
    tempDirs.push(dir);
    const url = `file:${join(dir, "control-plane.sqlite")}`;
    const first = await createControlPlaneStore({ url });
    const second = await createControlPlaneStore({ url });
    try {
      const limit = 3;
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          (index % 2 === 0 ? first : second).claimDailyProvisioning(DAY, limit),
        ),
      );

      expect(results.filter((result) => result.admitted)).toHaveLength(limit);
      expect(results.filter((result) => !result.admitted)).toHaveLength(10 - limit);
      expect(await provisionedOn(first, DAY)).toBe(limit);
      // Every admitted claim landed on a distinct count: no two shared a place.
      const admittedCounts = results
        .filter((result) => result.admitted)
        .map((result) => result.provisionedToday)
        .sort();
      expect(admittedCounts).toEqual([1, 2, 3]);
    } finally {
      first.close();
      second.close();
    }
  });
});
