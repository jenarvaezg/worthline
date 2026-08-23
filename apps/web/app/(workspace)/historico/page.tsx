import { resolvePageShell } from "@web/page-shell";
import { COMPOSITION_RANGES, valuationMethodOfAsset } from "@worthline/domain";
import { Suspense } from "react";
import { buildHistoricoBreakdownView } from "./build-historico-breakdown";
import HistoricoBreakdown from "./historico-breakdown";
import {
  HISTORICO_RANGE_LABELS,
  historicoRangeHref,
  historicoWindowFrom,
  parseHistoricoRangeParam,
  searchFromParams,
} from "./historico-range";
import HistoricoSkeleton from "./historico-skeleton";
import { buildHistoricoRows, HistoricoTable } from "./historico-table";

/**
 * /historico — Stream (#1229). Sync page + Suspense body so Partial Prefetching
 * can ship HistoricoSkeleton as the reusable per-route shell.
 *
 * Snapshot reads are windowed to the selected range (#1535). Changing the range
 * navigates (interaction-patterns §2 exception): the cost is the dataset, so
 * the alternatives are not preloaded.
 */
export default function HistoricoPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<HistoricoSkeleton />}>
      <HistoricoContent searchParams={searchParams} />
    </Suspense>
  );
}

export async function HistoricoContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const shell = await resolvePageShell({ searchParams: resolvedSearchParams });
  const { privacyMode, selectedScope, store, workspace } = shell;

  const today = new Date().toISOString().slice(0, 10);
  const range = parseHistoricoRangeParam(resolvedSearchParams.range);
  const from = historicoWindowFrom(today, range);
  const windowQuery = from === undefined ? {} : { from };
  const search = searchFromParams(resolvedSearchParams);

  const projectionContext = await store.snapshots.buildProjectionContext();
  const [snapshots, holdingRecords, assets, liabilities, payoutRecords, payoutSchedules] =
    await Promise.all([
      selectedScope
        ? store.snapshots.readSnapshots(selectedScope.id, windowQuery)
        : Promise.resolve([]),
      selectedScope
        ? store.snapshots.readSnapshotHoldings({
            scopeId: selectedScope.id,
            ...windowQuery,
          })
        : Promise.resolve([]),
      store.assets.readAssets(projectionContext),
      store.liabilities.readLiabilities(),
      store.payouts.readPayouts(),
      store.payouts.readPayoutSchedules(),
    ]);

  // Reuse operations already read into the projection context instead of one
  // readOperations query per derived asset (#1535, same pattern as /objetivos #1235).
  const operationsByHoldingId = new Map(
    assets
      .filter((asset) => valuationMethodOfAsset(asset) === "derived")
      .map(
        (asset) =>
          [asset.id, projectionContext.operationsByAsset.get(asset.id) ?? []] as const,
      ),
  );

  const debtModelEntries = await Promise.all(
    liabilities.map(
      async (liability) =>
        [liability.id, await store.liabilities.readDebtModel(liability.id)] as const,
    ),
  );

  const debtModelByLiabilityId = new Map(debtModelEntries);

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
        <div className="historyControls">
          <nav className="rangeTabs" aria-label="Rango temporal del histórico">
            {COMPOSITION_RANGES.map((option) => {
              const isActive = option === range;
              return (
                <a
                  aria-current={isActive ? "true" : undefined}
                  className={isActive ? "active" : undefined}
                  href={historicoRangeHref(search, option)}
                  key={option}
                >
                  {HISTORICO_RANGE_LABELS[option]}
                </a>
              );
            })}
          </nav>
          <span>{snapshots.length} capturas</span>
        </div>
      </div>

      {snapshots.length === 0 ? (
        <p className="emptyLine historicoEmpty">
          {range === "all"
            ? "El histórico se acumula solo: cada día que abres worthline se guarda una captura. Vuelve mañana para ver tu primera comparativa."
            : "No hay capturas en este periodo. Amplía el rango o vuelve mañana."}
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
