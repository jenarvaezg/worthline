import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createControlPlaneStore,
  createInMemoryControlPlaneStore,
  type ProvisioningQuota,
} from "@db/control-plane";
import { afterAll, describe, expect, it } from "vitest";

// Cross the real ProvisioningQuota port seam: the in-memory store implements the
// whole control plane, but these tests depend only on the daily provisioning cap.
type QuotaStore = ProvisioningQuota & { close(): void };

// Illustrative caps only — the real figure lives in the deployment's env, never here.
const DAY = "2026-03-14";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
});

describe("control plane daily provisioning cap (#1175)", () => {
  it("grants slots up to the cap and refuses the next one", async () => {
    const store: QuotaStore = await createInMemoryControlPlaneStore();
    try {
      expect(await store.claimWorkspaceProvisionSlot(DAY, 2)).toEqual({
        granted: true,
        used: 1,
      });
      expect(await store.claimWorkspaceProvisionSlot(DAY, 2)).toEqual({
        granted: true,
        used: 2,
      });
      expect(await store.claimWorkspaceProvisionSlot(DAY, 2)).toEqual({
        granted: false,
        used: 2,
      });
      // A refusal does not consume anything: the count stays at the cap.
      expect(await store.readWorkspaceProvisionCount(DAY)).toBe(2);
    } finally {
      store.close();
    }
  });

  it("a cap of zero refuses without opening a row for the day", async () => {
    const store: QuotaStore = await createInMemoryControlPlaneStore();
    try {
      expect(await store.claimWorkspaceProvisionSlot(DAY, 0)).toEqual({
        granted: false,
        used: 0,
      });
      expect(await store.readWorkspaceProvisionCount(DAY)).toBe(0);
    } finally {
      store.close();
    }
  });

  it("starts every UTC day from zero", async () => {
    const store: QuotaStore = await createInMemoryControlPlaneStore();
    try {
      await store.claimWorkspaceProvisionSlot("2026-03-14", 1);
      expect(await store.claimWorkspaceProvisionSlot("2026-03-14", 1)).toEqual({
        granted: false,
        used: 1,
      });

      expect(await store.claimWorkspaceProvisionSlot("2026-03-15", 1)).toEqual({
        granted: true,
        used: 1,
      });
      // Yesterday's count is untouched by today's claim.
      expect(await store.readWorkspaceProvisionCount("2026-03-14")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("a released slot goes back to the day it was claimed on, never below zero", async () => {
    const store: QuotaStore = await createInMemoryControlPlaneStore();
    try {
      await store.claimWorkspaceProvisionSlot(DAY, 1);
      await store.releaseWorkspaceProvisionSlot(DAY);
      expect(await store.readWorkspaceProvisionCount(DAY)).toBe(0);
      expect(await store.claimWorkspaceProvisionSlot(DAY, 1)).toEqual({
        granted: true,
        used: 1,
      });

      // Releasing more than was claimed (or on a day with no row) is a no-op.
      await store.releaseWorkspaceProvisionSlot(DAY);
      await store.releaseWorkspaceProvisionSlot(DAY);
      await store.releaseWorkspaceProvisionSlot("2026-03-01");
      expect(await store.readWorkspaceProvisionCount(DAY)).toBe(0);
      expect(await store.readWorkspaceProvisionCount("2026-03-01")).toBe(0);
    } finally {
      store.close();
    }
  });

  it("two connections racing for the last slots never exceed the cap", async () => {
    // Two independent control-plane connections over ONE database file — the
    // shape of two serverless instances sharing the hosted control plane.
    const dir = mkdtempSync(join(tmpdir(), "worthline-provision-quota-"));
    tempDirs.push(dir);
    const url = `file:${join(dir, "control-plane.sqlite")}`;
    const first = await createControlPlaneStore({ url });
    const second = await createControlPlaneStore({ url });
    try {
      const cap = 3;
      const attempts = Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? first : second).claimWorkspaceProvisionSlot(DAY, cap),
      );
      const results = await Promise.all(attempts);

      expect(results.filter((result) => result.granted)).toHaveLength(cap);
      expect(results.filter((result) => !result.granted)).toHaveLength(10 - cap);
      expect(await first.readWorkspaceProvisionCount(DAY)).toBe(cap);
      // Every granted claim saw a distinct running count: no two shared a slot.
      const grantedCounts = results
        .filter((result) => result.granted)
        .map((result) => result.used)
        .sort();
      expect(grantedCounts).toEqual([1, 2, 3]);
    } finally {
      first.close();
      second.close();
    }
  });
});
