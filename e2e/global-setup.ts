import { createWorthlineStore } from "@worthline/db";
import { captureNetWorthSnapshot } from "@worthline/domain";

export default async function globalSetup(): Promise<void> {
  const databasePath = process.env.WORTHLINE_DB_PATH;
  if (!databasePath) {
    throw new Error("WORTHLINE_DB_PATH must be set for e2e globalSetup");
  }

  const store = createWorthlineStore({ databasePath });

  store.workspace.initializeWorkspace({
    mode: "individual",
    members: [{ id: "member_seed", name: "Seed" }],
  });

  store.assets.createManualAsset({
    id: "asset_seed",
    name: "Caja seed",
    type: "cash",
    currency: "EUR",
    currentValueMinor: 50_000,
    liquidityTier: "cash",
    ownership: [{ memberId: "member_seed", shareBps: 10_000 }],
  });

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayIso = yesterday.toISOString();

  const workspace = store.workspace.readWorkspace();
  if (!workspace) {
    throw new Error("Workspace not initialized");
  }

  const assets = store.assets.readAssets();

  const snapshot = captureNetWorthSnapshot({
    workspace,
    scopeId: "total",
    scopeLabel: "Total",
    assets,
    capturedAt: yesterdayIso,
    id: "snapshot_seed_yesterday",
  });

  store.snapshots.saveSnapshot({ snapshot });

  store.close();
}
