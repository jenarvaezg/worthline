import { resolvePageShell } from "@web/page-shell";
import { valuationMethodOfAsset } from "@worthline/domain";
import { Suspense } from "react";
import { buildHistoricoBreakdownView } from "./build-historico-breakdown";
import HistoricoBreakdown from "./historico-breakdown";
import HistoricoSkeleton from "./historico-skeleton";
import { buildHistoricoRows, HistoricoTable } from "./historico-table";

export const dynamic = "force-dynamic";

export default async function HistoricoPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Lightweight preamble (#1195): auth + workspace context (memoized, already
  // resolved by the shared layout) run before we emit anything, so any redirect
  // fires here. The heavy snapshot/breakdown reads stream in the Suspense body
  // below — the chrome + skeleton paint immediately on navigation.
  const resolvedSearchParams = (await searchParams) ?? {};
  const shell = await resolvePageShell({ searchParams: resolvedSearchParams });

  return (
    <Suspense fallback={<HistoricoSkeleton />}>
      <HistoricoContent shell={shell} />
    </Suspense>
  );
}

export async function HistoricoContent({
  shell,
}: {
  shell: Awaited<ReturnType<typeof resolvePageShell>>;
}) {
  const { privacyMode, selectedScope, store, workspace } = shell;

  const today = new Date().toISOString().slice(0, 10);

  const [snapshots, holdingRecords, assets, liabilities, payoutRecords, payoutSchedules] =
    await Promise.all([
      selectedScope
        ? store.snapshots.readSnapshots(selectedScope.id)
        : Promise.resolve([]),
      selectedScope
        ? store.snapshots.readSnapshotHoldings({ scopeId: selectedScope.id })
        : Promise.resolve([]),
      store.assets.readAssets(),
      store.liabilities.readLiabilities(),
      store.payouts.readPayouts(),
      store.payouts.readPayoutSchedules(),
    ]);

  const derivedAssetIds = assets
    .filter((asset) => valuationMethodOfAsset(asset) === "derived")
    .map((asset) => asset.id);
  const operationEntries = await Promise.all(
    derivedAssetIds.map(
      async (assetId) =>
        [assetId, await store.operations.readOperations(assetId)] as const,
    ),
  );

  const debtModelEntries = await Promise.all(
    liabilities.map(
      async (liability) =>
        [liability.id, await store.liabilities.readDebtModel(liability.id)] as const,
    ),
  );

  const debtModelByLiabilityId = new Map(debtModelEntries);
  const operationsByHoldingId = new Map(operationEntries);

  const rows = buildHistoricoRows(snapshots, holdingRecords, today);
  const breakdown =
    selectedScope === undefined
      ? { geometry: null, periods: [], showsPayoutBand: false }
      : buildHistoricoBreakdownView({
          assets,
          holdingRecords,
          debtModelByLiabilityId,
          liabilities,
          operationsByHoldingId,
          payoutRecords,
          payoutSchedules,
          scopeId: selectedScope.id,
          snapshots,
          today,
          workspace,
        });

  return (
    <section className="historicoPanel section" aria-label="Histórico de snapshots">
      <div className="panelHeader">
        <h2>Histórico</h2>
        <span>{snapshots.length} capturas</span>
      </div>

      {snapshots.length === 0 ? (
        <p className="emptyLine historicoEmpty">
          El histórico se acumula solo: cada día que abres worthline se guarda una
          captura. Vuelve mañana para ver tu primera comparativa.
        </p>
      ) : (
        <>
          <HistoricoBreakdown breakdown={breakdown} />
          <HistoricoTable privacyMode={privacyMode} rows={rows} />
        </>
      )}
    </section>
  );
}
