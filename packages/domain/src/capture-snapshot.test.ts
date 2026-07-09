/**
 * Snapshot capture orchestration (PRD #120 candidate 2, issue #127).
 *
 * Pure unit coverage for the scope-in → capture-out deep module: it decides
 * whether to capture (same-day policy), builds the valued snapshot plus its
 * reconciled holding rows, mints a stable id through injected id generation,
 * and reports whether the capture replaces a same-day snapshot.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildSnapshotId, captureSnapshotForScope } from "./capture-snapshot";
import type { ManualAsset, NetWorthSnapshot, Workspace } from "./index";
import { captureNetWorthSnapshot, createManualAsset, createWorkspace } from "./index";
import type { ScopeOption } from "./scope";

const HOUSEHOLD: ScopeOption = { id: "household", label: "Hogar", type: "household" };

afterEach(() => {
  vi.restoreAllMocks();
});

function makeWorkspace(): Workspace {
  return createWorkspace({
    baseCurrency: "EUR",
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
}

function makeAssets(workspace: Workspace): ManualAsset[] {
  return [
    createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 50_000_00,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Cuenta corriente",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    }),
  ];
}

/** An existing snapshot for the given scope/date — only the policy fields matter. */
function existingSnapshot(workspace: Workspace, capturedAt: string): NetWorthSnapshot {
  return captureNetWorthSnapshot({
    assets: [],
    capturedAt,
    id: "existing",
    liabilities: [],
    scopeId: "household",
    scopeLabel: "Hogar",
    workspace,
  });
}

describe("captureSnapshotForScope", () => {
  test("captures a snapshot with reconciled holdings for the scope", () => {
    const workspace = makeWorkspace();
    const result = captureSnapshotForScope({
      assets: makeAssets(workspace),
      capturedAt: "2026-06-12T10:00:00.000Z",
      existingSnapshots: [],
      liabilities: [],
      scope: HOUSEHOLD,
      workspace,
    });

    expect(result).not.toBeNull();
    expect(result.snapshot.scopeId).toBe("household");
    expect(result.snapshot.scopeLabel).toBe("Hogar");
    expect(result.snapshot.dateKey).toBe("2026-06-12");
    expect(result.snapshot.totalNetWorth.amountMinor).toBe(50_000_00);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]!.holdingId).toBe("asset_cash");
    expect(result.replace).toBe(false);
  });

  test("flags replace when a same-day snapshot already exists (latest wins)", () => {
    const workspace = makeWorkspace();
    const result = captureSnapshotForScope({
      assets: makeAssets(workspace),
      capturedAt: "2026-06-12T18:00:00.000Z",
      existingSnapshots: [existingSnapshot(workspace, "2026-06-12T08:00:00.000Z")],
      liabilities: [],
      scope: HOUSEHOLD,
      workspace,
    });

    expect(result).not.toBeNull();
    expect(result.replace).toBe(true);
  });

  test("does not flag replace when the existing snapshot is from a prior day", () => {
    const workspace = makeWorkspace();
    const result = captureSnapshotForScope({
      assets: makeAssets(workspace),
      capturedAt: "2026-06-12T10:00:00.000Z",
      existingSnapshots: [existingSnapshot(workspace, "2026-06-11T10:00:00.000Z")],
      liabilities: [],
      scope: HOUSEHOLD,
      workspace,
    });

    expect(result).not.toBeNull();
    expect(result.replace).toBe(false);
  });

  test("calls injected generateId with scope id, capturedAt and the seed", () => {
    const workspace = makeWorkspace();
    const generateId = vi.fn(() => "snapshot_custom_id");
    const seed = vi.fn(() => 42);

    const result = captureSnapshotForScope(
      {
        assets: makeAssets(workspace),
        capturedAt: "2026-06-12T10:00:00.000Z",
        existingSnapshots: [],
        liabilities: [],
        scope: HOUSEHOLD,
        workspace,
      },
      { generateId, seed },
    );

    expect(seed).toHaveBeenCalledTimes(1);
    expect(generateId).toHaveBeenCalledWith("household", "2026-06-12T10:00:00.000Z", 42);
    expect(result.snapshot.id).toBe("snapshot_custom_id");
  });

  test("defaults to buildSnapshotId when no generateId is injected", () => {
    const workspace = makeWorkspace();
    const result = captureSnapshotForScope(
      {
        assets: makeAssets(workspace),
        capturedAt: "2026-06-12T10:00:00.000Z",
        existingSnapshots: [],
        liabilities: [],
        scope: HOUSEHOLD,
        workspace,
      },
      { seed: () => 7 },
    );

    expect(result.snapshot.id).toBe("snapshot_household_2026_06_12_7");
  });
});

describe("buildSnapshotId", () => {
  test("is deterministic from scope and capture date (moved from intake)", () => {
    expect(buildSnapshotId("household", "2026-06-08T21:00:00.000Z", 3)).toBe(
      "snapshot_household_2026_06_08_3",
    );
  });

  test("truncates capturedAt to the date so same-day recaptures share a slug", () => {
    expect(buildSnapshotId("member_jose", "2026-06-12T08:00:00.000Z", 1)).toBe(
      "snapshot_member_jose_2026_06_12_1",
    );
    expect(buildSnapshotId("member_jose", "2026-06-12T22:00:00.000Z", 2)).toBe(
      "snapshot_member_jose_2026_06_12_2",
    );
  });
});
