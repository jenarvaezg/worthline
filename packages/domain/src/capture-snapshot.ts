/**
 * Snapshot capture orchestration (deep module, PRD #120 candidate 2).
 *
 * Consolidates the multi-step snapshot capture sequence that previously lived
 * inline in the dashboard load path: decide whether to capture, build the
 * valued snapshot plus its frozen holding rows, and mint a stable id — behind a
 * single scope-in → capture-out function.
 *
 * Pure: no I/O, no store access, no clock or randomness of its own. The id
 * generator and the capture timestamp are injected so the function is
 * deterministic and testable in isolation. The caller persists the result.
 */

import type { Liability, ManualAsset, Workspace } from "./workspace-types";
import type { NetWorthSnapshot } from "./snapshot-types";
import { captureValuedNetWorthSnapshot } from "./snapshot-types";
import type { ScopeOption } from "./scope";
import type { InvestmentCaptureDetail, SnapshotHoldingRow } from "./snapshot-holdings";
import { planSnapshotCapture } from "./snapshot-policy";

/**
 * Everything the orchestration needs for one scope. `assets`, `liabilities`,
 * `workspace`, and `investmentDetails` are shared across scopes and read once
 * by the caller; `scope` and `existingSnapshots` are per-scope.
 */
export interface CaptureSnapshotInput {
  /** The scope (household or member/group) to capture for. */
  scope: ScopeOption;
  workspace: Workspace;
  /** Snapshots already stored for this scope — drives the same-day policy. */
  existingSnapshots: NetWorthSnapshot[];
  assets: ManualAsset[];
  liabilities: Liability[];
  /** Per-investment units and unit price at capture time, keyed by asset id. */
  investmentDetails?: ReadonlyMap<string, InvestmentCaptureDetail>;
  /** "Now" as an ISO timestamp — the snapshot's capturedAt and id seed source. */
  capturedAt: string;
}

/**
 * A capture ready to persist: the snapshot, its frozen holding rows, and the
 * replace flag derived from the same-day policy (true when an existing snapshot
 * for today should be overwritten — latest wins).
 */
export interface CaptureSnapshotOutput {
  snapshot: NetWorthSnapshot;
  holdings: SnapshotHoldingRow[];
  /** True when this capture replaces an existing same-day snapshot. */
  replace: boolean;
}

/**
 * Orchestrate a single scope's snapshot capture (ADR 0005, ADR 0008).
 *
 * 1. `planSnapshotCapture` decides whether to capture and whether to replace a
 *    same-day snapshot.
 * 2. When capturing, `captureValuedNetWorthSnapshot` builds the snapshot and its
 *    reconciled holding rows.
 * 3. A stable id is minted via the injected `generateId` (defaults to the
 *    built-in `buildSnapshotId`).
 *
 * Returns `null` when the policy says not to capture, so the caller can skip
 * persistence entirely.
 */
export function captureSnapshotForScope(
  input: CaptureSnapshotInput,
  options: {
    /** Inject a deterministic seed source; defaults to `Date.now()`. */
    seed?: () => number;
    /** Inject id generation; defaults to the built-in `buildSnapshotId`. */
    generateId?: (scopeId: string, capturedAt: string, seed: number) => string;
  } = {},
): CaptureSnapshotOutput | null {
  const generateId = options.generateId ?? buildSnapshotId;
  const seed = options.seed ?? (() => Date.now());

  const plan = planSnapshotCapture(
    input.existingSnapshots,
    input.scope.id,
    input.capturedAt.slice(0, 10),
  );

  if (!plan.shouldCapture) {
    return null;
  }

  const { snapshot, holdings } = captureValuedNetWorthSnapshot({
    assets: input.assets,
    capturedAt: input.capturedAt,
    id: generateId(input.scope.id, input.capturedAt, seed()),
    liabilities: input.liabilities,
    scopeId: input.scope.id,
    scopeLabel: input.scope.label,
    workspace: input.workspace,
    ...(input.investmentDetails ? { investmentDetails: input.investmentDetails } : {}),
  });

  return { holdings, replace: plan.replacesId !== undefined, snapshot };
}

/**
 * Mint a stable, deterministic snapshot id from the scope and the capture date.
 * The date is truncated to YYYY-MM-DD so same-day recaptures share a slug; the
 * seed disambiguates. Moved here from the web intake seam (issue #127): the id
 * shape belongs with the capture orchestration that owns it.
 */
export function buildSnapshotId(
  scopeId: string,
  capturedAt: string,
  seed: number,
): string {
  const dateKey = capturedAt.slice(0, 10);
  const slug =
    `${scopeId}_${dateKey}`
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "snapshot";

  return `snapshot_${slug}_${seed}`;
}
