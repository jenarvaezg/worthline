import type { MoneyMinor } from "./money";
import { subtractMoney } from "./money";
import type { DomainWarning } from "./warnings";
import { collectWarnings } from "./warnings";
import { deriveMonthlyCloses } from "./snapshot-policy";
import type { InvestmentCaptureDetail, SnapshotHoldingRow } from "./snapshot-holdings";
import {
  assertSnapshotHoldingsReconcile,
  buildSnapshotHoldingRows,
} from "./snapshot-holdings";
import type { Liability, ManualAsset, Workspace } from "./workspace-types";
import type { NetWorthSummary } from "./net-worth";
import { calculateNetWorth } from "./net-worth";

export interface NetWorthSnapshot {
  id: string;
  scopeId: string;
  scopeLabel: string;
  capturedAt: string;
  dateKey: string;
  monthKey: string;
  isMonthlyClose: boolean;
  totalNetWorth: MoneyMinor;
  liquidNetWorth: MoneyMinor;
  housingEquity: MoneyMinor;
  grossAssets: MoneyMinor;
  debts: MoneyMinor;
  warnings: DomainWarning[];
}

export interface CreateNetWorthSnapshotInput {
  id: string;
  scopeId: string;
  scopeLabel: string;
  capturedAt: string;
  summary: NetWorthSummary;
  isMonthlyClose?: boolean;
  warnings?: DomainWarning[];
}

export interface SnapshotDeltas {
  snapshot: NetWorthSnapshot;
  previousSnapshot?: NetWorthSnapshot;
  previousMonthlyClose?: NetWorthSnapshot;
  changeSincePrevious?: MoneyMinor;
  changeSinceMonthlyClose?: MoneyMinor;
}

export function createNetWorthSnapshot(
  input: CreateNetWorthSnapshotInput,
): NetWorthSnapshot {
  const capturedAt = new Date(input.capturedAt);

  if (Number.isNaN(capturedAt.getTime())) {
    throw new Error("Snapshot capturedAt must be a valid date.");
  }

  const dateKey = input.capturedAt.slice(0, 10);
  const monthKey = dateKey.slice(0, 7);

  return {
    capturedAt: input.capturedAt,
    dateKey,
    debts: { ...input.summary.debts },
    grossAssets: { ...input.summary.grossAssets },
    housingEquity: { ...input.summary.housingEquity },
    id: input.id,
    isMonthlyClose: input.isMonthlyClose ?? false,
    liquidNetWorth: { ...input.summary.liquidNetWorth },
    monthKey,
    scopeId: input.scopeId,
    scopeLabel: input.scopeLabel,
    totalNetWorth: { ...input.summary.totalNetWorth },
    warnings: input.warnings ?? [],
  };
}

export function captureNetWorthSnapshot(input: {
  workspace: Workspace;
  scopeId: string;
  scopeLabel: string;
  assets: ManualAsset[];
  liabilities?: Liability[];
  capturedAt: string;
  id: string;
  isMonthlyClose?: boolean;
}): NetWorthSnapshot {
  const summary = calculateNetWorth({
    workspace: input.workspace,
    scopeId: input.scopeId,
    assets: input.assets,
    ...(input.liabilities ? { liabilities: input.liabilities } : {}),
  });
  const warnings = collectWarnings(input.assets);

  return createNetWorthSnapshot({
    capturedAt: input.capturedAt,
    id: input.id,
    ...(input.isMonthlyClose ? { isMonthlyClose: input.isMonthlyClose } : {}),
    scopeId: input.scopeId,
    scopeLabel: input.scopeLabel,
    summary,
    warnings,
  });
}

/** A snapshot plus the valued portfolio behind its figures (ADR 0008). */
export interface ValuedNetWorthSnapshot {
  snapshot: NetWorthSnapshot;
  holdings: SnapshotHoldingRow[];
}

/**
 * Capture a snapshot together with its holding rows (ADR 0008).
 *
 * Produces the same five headline figures as `captureNetWorthSnapshot` plus one
 * frozen row per holding behind them, scope-weighted identically. Enforces the
 * reconciliation invariant before returning: if the rows do not sum exactly to
 * the headline gross assets and debts, the capture fails loudly so nothing
 * partial can be persisted.
 */
export function captureValuedNetWorthSnapshot(input: {
  workspace: Workspace;
  scopeId: string;
  scopeLabel: string;
  assets: ManualAsset[];
  liabilities?: Liability[];
  capturedAt: string;
  id: string;
  isMonthlyClose?: boolean;
  /** Per-investment units and unit price, keyed by asset id. */
  investmentDetails?: ReadonlyMap<string, InvestmentCaptureDetail>;
}): ValuedNetWorthSnapshot {
  const snapshot = captureNetWorthSnapshot(input);
  const holdings = buildSnapshotHoldingRows({
    assets: input.assets,
    scopeId: input.scopeId,
    workspace: input.workspace,
    ...(input.liabilities ? { liabilities: input.liabilities } : {}),
    ...(input.investmentDetails ? { investmentDetails: input.investmentDetails } : {}),
  });

  assertSnapshotHoldingsReconcile(holdings, {
    debtsMinor: snapshot.debts.amountMinor,
    grossAssetsMinor: snapshot.grossAssets.amountMinor,
  });

  return { holdings, snapshot };
}

export function calculateSnapshotDeltas(
  snapshots: NetWorthSnapshot[],
  snapshotId: string,
): SnapshotDeltas {
  const snapshot = snapshots.find((candidate) => candidate.id === snapshotId);

  if (!snapshot) {
    throw new Error(`Unknown snapshot ${snapshotId}.`);
  }

  const scopedSnapshots = snapshots
    .filter((candidate) => candidate.scopeId === snapshot.scopeId)
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  const index = scopedSnapshots.findIndex((candidate) => candidate.id === snapshot.id);
  const previousSnapshot = index > 0 ? scopedSnapshots[index - 1] : undefined;

  // Monthly closes are derived — the last snapshot of each calendar month wins.
  // The reference close for delta is the most recent close from a prior month
  // (different from the current snapshot's month).
  const priorMonthSnapshots = scopedSnapshots
    .slice(0, index)
    .filter((candidate) => candidate.monthKey < snapshot.monthKey);
  const monthlyCloseIds = deriveMonthlyCloses(priorMonthSnapshots);
  const closedMonthIds = new Set(monthlyCloseIds.values());
  const previousMonthlyClose = priorMonthSnapshots
    .slice()
    .reverse()
    .find((candidate) => closedMonthIds.has(candidate.id));

  return {
    snapshot,
    ...(previousSnapshot
      ? {
          changeSincePrevious: subtractMoney(
            snapshot.totalNetWorth,
            previousSnapshot.totalNetWorth,
          ),
          previousSnapshot,
        }
      : {}),
    ...(previousMonthlyClose
      ? {
          changeSinceMonthlyClose: subtractMoney(
            snapshot.totalNetWorth,
            previousMonthlyClose.totalNetWorth,
          ),
          previousMonthlyClose,
        }
      : {}),
  };
}
