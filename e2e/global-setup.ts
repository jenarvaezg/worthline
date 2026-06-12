import { createWorthlineStore } from "@worthline/db";
import { captureNetWorthSnapshot } from "@worthline/domain";

export default async function globalSetup(): Promise<void> {
  const databasePath = process.env.WORTHLINE_DB_PATH;
  if (!databasePath) {
    throw new Error("WORTHLINE_DB_PATH must be set for e2e globalSetup");
  }

  const store = createWorthlineStore({ databasePath });

  store.workspace.initializeWorkspace({
    mode: "household",
    members: [
      { id: "member_seed", name: "Seed" },
      { id: "member_socio", name: "Socio" },
    ],
  });

  store.assets.createManualAsset({
    id: "asset_seed",
    name: "Caja seed",
    type: "cash",
    currency: "EUR",
    currentValueMinor: 50_000,
    liquidityTier: "cash",
    ownership: [
      { memberId: "member_seed", shareBps: 5000 },
      { memberId: "member_socio", shareBps: 5000 },
    ],
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
    scopeId: "household",
    scopeLabel: "Hogar",
    assets,
    capturedAt: yesterdayIso,
    id: "snapshot_seed_yesterday",
  });

  store.snapshots.saveSnapshot({ snapshot });

  store.close();
}
