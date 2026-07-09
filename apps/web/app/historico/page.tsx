import {
  buildCurrentUrl,
  PRIVACY_COOKIE_NAME,
  parsePrivacyCookie,
  parseScopeCookie,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import Shell from "@web/shell";
import { bootstrapHealthcheck, withStore } from "@web/store";
import { listScopeOptions } from "@worthline/domain";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
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
    const snapshots = selectedScope
      ? await store.snapshots.readSnapshots(selectedScope.id)
      : [];
    // Frozen per-holding rows (ADR 0008) drive the per-day breakdown of movers.
    const holdingRecords = selectedScope
      ? await store.snapshots.readSnapshotHoldings({ scopeId: selectedScope.id })
      : [];

    return { scopes, selectedScope, snapshots, holdingRecords };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const { scopes, selectedScope, snapshots, holdingRecords } = storeData;

  const today = new Date().toISOString().slice(0, 10);
  const rows = buildHistoricoRows(snapshots, holdingRecords, today);

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
      warnings={[]}
    >
      <section className="historicoPanel" aria-label="Histórico de snapshots">
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
          <HistoricoTable privacyMode={privacyMode} rows={rows} />
        )}
      </section>
    </Shell>
  );
}
