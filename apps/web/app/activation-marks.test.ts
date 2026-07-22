import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlaneStore } from "@worthline/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import { markFirstHoldingBestEffort, markOnboardedBestEffort } from "./activation-marks";
import type { StoreTarget } from "./store-resolver";

const tempDirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

/** A real file-backed control plane with one workspace row (the marks carry FKs). */
async function controlPlaneWithWorkspace(): Promise<{
  url: string;
  workspaceId: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "worthline-activation-"));
  tempDirs.push(dir);
  const url = `file:${join(dir, "cp.sqlite")}`;
  const store = await createControlPlaneStore({ url });
  try {
    const ws = await store.createWorkspace({
      dbName: "wl-test",
      dbUrl: "file:ws.sqlite",
    });
    return { url, workspaceId: ws.id };
  } finally {
    store.close();
  }
}

function authenticated(workspaceId: string): StoreTarget {
  return { kind: "authenticated", workspaceId, dbUrl: "file:ws.sqlite", token: "t" };
}

describe("activation marks (#1131, PRD #1160 S1)", () => {
  it("is a no-op without a control plane configured — dev/tests never trip it", async () => {
    vi.stubEnv("WORTHLINE_CONTROL_PLANE_DB_URL", "");
    await expect(markFirstHoldingBestEffort()).resolves.toBeUndefined();
    await expect(markOnboardedBestEffort()).resolves.toBeUndefined();
  });

  it("stamps first_holding_at for an authenticated workspace, set-once", async () => {
    const { url, workspaceId } = await controlPlaneWithWorkspace();
    vi.stubEnv("WORTHLINE_CONTROL_PLANE_DB_URL", url);

    await markFirstHoldingBestEffort(authenticated(workspaceId));
    const store = await createControlPlaneStore({ url });
    const first = await store.readWorkspaceEntitlement(workspaceId);
    expect(first?.firstHoldingAt).not.toBeNull();

    // A later holding write never moves the stamp.
    await markFirstHoldingBestEffort(authenticated(workspaceId));
    const again = await store.readWorkspaceEntitlement(workspaceId);
    expect(again?.firstHoldingAt).toBe(first?.firstHoldingAt);
    store.close();
  });

  it("stamps onboarded_at independently of first_holding_at", async () => {
    const { url, workspaceId } = await controlPlaneWithWorkspace();
    vi.stubEnv("WORTHLINE_CONTROL_PLANE_DB_URL", url);

    await markOnboardedBestEffort(authenticated(workspaceId));
    const store = await createControlPlaneStore({ url });
    const entitlement = await store.readWorkspaceEntitlement(workspaceId);
    expect(entitlement?.onboardedAt).not.toBeNull();
    expect(entitlement?.firstHoldingAt).toBeNull();
    // The mark never invents a plan — the row stays free until a trial/grant.
    expect(entitlement?.plan).toBe("free");
    store.close();
  });

  it("never stamps for demo or local targets", async () => {
    const { url, workspaceId } = await controlPlaneWithWorkspace();
    vi.stubEnv("WORTHLINE_CONTROL_PLANE_DB_URL", url);

    await markFirstHoldingBestEffort({ kind: "demo", now: "", persona: "sofia" });
    await markOnboardedBestEffort({ kind: "local" });

    const store = await createControlPlaneStore({ url });
    expect(await store.readWorkspaceEntitlement(workspaceId)).toBeNull();
    store.close();
  });
});
