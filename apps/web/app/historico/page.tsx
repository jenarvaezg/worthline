import {
  buildCurrentUrl,
  PRIVACY_COOKIE_NAME,
  parsePrivacyCookie,
  parseScopeCookie,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import Shell from "@web/shell";
import { bootstrapHealthcheck, withStore } from "@web/store";
import { listScopeOptions, valuationMethodOfAsset } from "@worthline/domain";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { buildHistoricoBreakdownView } from "./build-historico-breakdown";
import HistoricoBreakdown from "./historico-breakdown";
import { buildHistoricoRows, HistoricoTable } from "./historico-table";

export const dynamic = "force-dynamic";

export default async function HistoricoPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const persistence = await bootstrapHealthcheck();
  const currentUrl = buildCurrentUrl(resolvedSearchParams);

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);
  const privacyMode = parsePrivacyCookie(jar.get(PRIVACY_COOKIE_NAME)?.value);

  const storeData = await withStore(async (store) => {
    const workspace = await store.workspace.readWorkspace();

    if (!workspace) {
      return null;
    }

    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];
    const today = new Date().toISOString().slice(0, 10);

    const [
      snapshots,
      holdingRecords,
      assets,
      liabilities,
      payoutRecords,
      payoutSchedules,
    ] = await Promise.all([
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

    return {
      scopes,
      selectedScope,
      snapshots,
      holdingRecords,
      assets,
      liabilities,
      debtModelByLiabilityId: new Map(debtModelEntries),
      operationsByHoldingId: new Map(operationEntries),
      payoutRecords,
      payoutSchedules,
      today,
      workspace,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const {
    scopes,
    selectedScope,
    snapshots,
    holdingRecords,
    assets,
    liabilities,
    debtModelByLiabilityId,
    operationsByHoldingId,
    payoutRecords,
    payoutSchedules,
    today,
    workspace,
  } = storeData;

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
    <Shell
      activeSection="historico"
      currentPageUrl={currentUrl}
      persistence={{
        displayPath: persistence.displayPath,
        checkedAt: persistence.checkedAt,
      }}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
    >
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
    </Shell>
  );
}
