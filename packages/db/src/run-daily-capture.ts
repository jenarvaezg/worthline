import { captureDailySnapshotForWorkspace } from "./capture-daily-snapshot";
import type { WorthlineStore } from "./store-types";

/** A workspace the cron must capture — its id and per-workspace database URL. */
export interface DailyCaptureWorkspace {
  id: string;
  dbUrl: string;
}

export interface RunDailyCaptureDeps {
  /** Enumerate every real workspace (control plane). */
  listAllWorkspaces: () => Promise<DailyCaptureWorkspace[]>;
  /** Open a workspace's store with the shared group token, no session. */
  openStore: (workspace: DailyCaptureWorkspace) => Promise<WorthlineStore>;
  /**
   * Refresh + persist this workspace's market prices before capture, so the
   * frozen value is fresh rather than stale. Naive per-workspace fetch in this
   * slice; cross-tenant dedup arrives later (PRD #528 S4).
   */
  fetchPrices: (store: WorthlineStore, now: string) => Promise<void>;
  /** Real wall-clock ISO timestamp — the day's close. Never the demo pin. */
  now: string;
}

export interface DailyCaptureFailure {
  workspaceId: string;
  error: string;
}

export interface RunDailyCaptureResult {
  total: number;
  captured: number;
  failures: DailyCaptureFailure[];
}

/**
 * Fleet daily snapshot capture (ADR 0037, PRD #528). Enumerates every real
 * workspace and, per workspace, refreshes prices then captures the day's
 * snapshot **unconditionally** — latest-wins (ADR 0005) overrides any
 * provisional intraday point a render wrote earlier, finalizing the day at its
 * close. A per-workspace `try/catch` isolates failures: one unreachable or
 * broken tenant never blocks the rest.
 *
 * Pure orchestration over injected seams — no control plane, no network, no
 * clock of its own (the cron route wires the real dependencies).
 */
export async function runDailyCapture(
  deps: RunDailyCaptureDeps,
): Promise<RunDailyCaptureResult> {
  const workspaces = await deps.listAllWorkspaces();
  const failures: DailyCaptureFailure[] = [];
  let captured = 0;

  for (const workspace of workspaces) {
    let store: WorthlineStore | undefined;
    try {
      store = await deps.openStore(workspace);
      await deps.fetchPrices(store, deps.now);
      await captureDailySnapshotForWorkspace(store, deps.now);
      captured += 1;
    } catch (error) {
      failures.push({
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      store?.close();
    }
  }

  return { total: workspaces.length, captured, failures };
}
