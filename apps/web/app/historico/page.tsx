import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import {
  deriveMonthlyCloses,
  formatMoneyMinor,
  listScopeOptions,
  moneySign,
} from "@worthline/domain";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  buildCurrentUrl,
  parseScopeCookie,
  scaleSignedBar,
  SCOPE_COOKIE_NAME,
} from "../intake";
import Shell from "../shell";

export const dynamic = "force-dynamic";

export default async function HistoricoPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = runBootstrapHealthcheck();
  const currentUrl = buildCurrentUrl(resolvedSearchParams);

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  const storeData = withStore((store) => {
    const workspace = store.workspace.readWorkspace();

    if (!workspace) {
      return null;
    }

    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];
    const snapshots = selectedScope ? store.snapshots.readSnapshots(selectedScope.id) : [];

    return { scopes, selectedScope, snapshots };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const { scopes, selectedScope, snapshots } = storeData;

  // Derive which snapshot ids are monthly closes (last snapshot of each calendar month).
  const monthlyCloseIds = new Set(deriveMonthlyCloses(snapshots).values());

  // Build rows in a single ascending pass (O(n)), then reverse for newest-first display.
  // delta = total − previous total; undefined for the first snapshot (no predecessor).
  const rows = snapshots
    .map((snapshot, idx) => {
      const prev = snapshots[idx - 1];
      const delta = prev
        ? {
            amountMinor:
              snapshot.totalNetWorth.amountMinor - prev.totalNetWorth.amountMinor,
            currency: snapshot.totalNetWorth.currency,
          }
        : undefined;
      return { snapshot, delta, isMonthlyClose: monthlyCloseIds.has(snapshot.id) };
    })
    .reverse();

  // Collect all per-row deltas for proportional bar scaling.
  const allDeltas = rows.map((row) => row.delta);

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
          <div className="tableScroll">
            <table className="historicoTable">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th className="numCol">Patrimonio neto</th>
                  <th className="numCol">Δ vs anterior</th>
                  <th className="barCol" aria-label="Variación relativa"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ snapshot, delta, isMonthlyClose }) => {
                  const barWidth = scaleSignedBar(delta, allDeltas);
                  const deltaSign = delta ? moneySign(delta) : undefined;

                  return (
                    <tr
                      key={snapshot.id}
                      className={isMonthlyClose ? "monthlyCloseRow" : undefined}
                    >
                      <td className="dateCell">
                        <span className="dateKey">{snapshot.dateKey}</span>
                        {isMonthlyClose ? (
                          <span className="monthlyCloseBadge" aria-label="Cierre de mes">
                            Cierre de mes
                          </span>
                        ) : null}
                      </td>
                      <td className={`numCol ${moneySign(snapshot.totalNetWorth)}`}>
                        {formatMoneyMinor(snapshot.totalNetWorth)}
                      </td>
                      <td className={`numCol ${deltaSign ?? ""}`}>
                        {delta ? formatMoneyMinor(delta) : "—"}
                      </td>
                      <td className="barCol" aria-hidden="true">
                        {barWidth > 0 ? (
                          <span
                            className={`deltaBar ${deltaSign ?? ""}`}
                            style={{ width: `${barWidth}%` }}
                          />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}
