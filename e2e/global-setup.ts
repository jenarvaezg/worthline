import { createWorthlineStore } from "@worthline/db";
import { captureValuedNetWorthSnapshot } from "@worthline/domain";

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

  // Seed a snapshot dated in the PREVIOUS calendar month. The composition chart
  // (#142) selects one base point per period (month) and only plots points that
  // carry frozen holding rows; with a single period it renders the "needs more
  // captures" placeholder and the band/legend drill links never appear. So we
  // seed a distinct earlier month — combined with today's auto-captured snapshot
  // the chart has two period points and renders during the serial run, which the
  // drilldown journeys (11/12) and the evolution journey (07) depend on.
  //
  // Day 15 of the prior month avoids month-length edge cases (e.g. seeding from
  // the 31st). The span stays under a year so availableCompositionRanges yields
  // only "all" and the range control (#144) correctly stays hidden.
  const lastMonth = new Date();
  lastMonth.setDate(15);
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  const seedCapturedAt = lastMonth.toISOString();

  const workspace = store.workspace.readWorkspace();
  if (!workspace) {
    throw new Error("Workspace not initialized");
  }

  const assets = store.assets.readAssets();

  // captureValuedNetWorthSnapshot also builds the frozen holding rows (ADR 0008)
  // — required so this point survives the composition series' row-backed filter.
  const { snapshot, holdings } = captureValuedNetWorthSnapshot({
    workspace,
    scopeId: "household",
    scopeLabel: "Hogar",
    assets,
    capturedAt: seedCapturedAt,
    id: "snapshot_seed_prev_month",
  });

  store.snapshots.saveSnapshot({ snapshot, holdings });

  store.close();
}
