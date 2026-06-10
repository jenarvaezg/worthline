import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import {
  formatMoneyMinor,
  getPriceFreshness,
  listScopeOptions,
  moneySign,
} from "@worthline/domain";
import { refreshStalePrices } from "@worthline/pricing";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  buildCurrentUrlFor,
  parseFormError,
  parseScopeCookie,
  priceFreshnessLabel,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "../intake";
import { refreshAndPersistStalePrices } from "../refresh-prices";
import Shell from "../shell";
import {
  hardDeleteInvestmentAction,
  refreshPricesAction,
  restoreInvestmentAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function InversionesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = runBootstrapHealthcheck();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  const currentUrl = buildCurrentUrlFor("/inversiones", resolvedSearchParams);

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  // Auto-refresh stale prices on load (same pattern as /)
  const investmentAssetsMeta = withStore((store) =>
    store.readInvestmentAssetsWithMeta(),
  );
  const initialPriceCache = withStore((store) =>
    store.readAllPriceCacheEntries(),
  );
  const { priceCache } = await refreshAndPersistStalePrices({
    cacheEntries: initialPriceCache,
    assets: investmentAssetsMeta,
    nowIso: persistence.checkedAt,
    refreshStalePrices,
    upsertPrice: (price) => withStore((store) => store.upsertPrice(price)),
    readCache: () => withStore((store) => store.readAllPriceCacheEntries()),
  });

  const storeData = withStore((store) => {
    const workspace = store.readWorkspace();

    if (!workspace) return null;

    const scopes = listScopeOptions(workspace);
    const selectedScope =
      scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];

    // Collect live investment asset ids so we can filter the trash to only
    // show deleted investment assets (not cash/manual/real_estate).
    const investmentMeta = store.readInvestmentAssetsWithMeta();
    const investmentIds = new Set(investmentMeta.map((a) => a.id));
    const trash = store.readTrash();

    return {
      positions: selectedScope
        ? store.readPositions(selectedScope.id)
        : [],
      trashedInvestments: trash.assets.filter((a) => investmentIds.has(a.id)),
      scopes,
      selectedScope,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const { positions, scopes, selectedScope, trashedInvestments } = storeData;

  return (
    <Shell
      activeSection="inversiones"
      currentPageUrl={currentUrl}
      persistence={persistence}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
      warnings={[]}
    >
      {formError && !formError.formId ? (
        <p className="errorBand" role="alert">
          {formError.message}
        </p>
      ) : null}

      {formOk ? (
        <p className="successBand" role="status">
          {formOk}
        </p>
      ) : null}

      <section className="inversionesSection" aria-label="Inversiones">
        <div className="panelHeader">
          <h2>Inversiones</h2>
          <Link className="actionLink" href="/inversiones/nueva">
            + Nueva inversión
          </Link>
        </div>

        <form action={refreshPricesAction} className="inlineForm">
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <button type="submit">Actualizar precios</button>
        </form>

        <div className="tableScroll">
          <table>
            <thead>
              <tr>
                <th>Inversión</th>
                <th>Unidades</th>
                <th>Coste medio</th>
                <th>
                  Precio/u · Frescura
                </th>
                <th>Valor</th>
                <th>P/L</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => {
                const cachedPrice = priceCache.find(
                  (entry) => entry.assetId === position.assetId,
                );
                const freshness = cachedPrice
                  ? getPriceFreshness(cachedPrice, persistence.checkedAt)
                  : null;

                return (
                  <tr id={position.assetId} key={position.assetId}>
                    <td>
                      {position.name}
                      {position.warnings.length > 0 ? (
                        <span
                          className="warnBadge"
                          title={position.warnings.join("; ")}
                        >
                          {" "}
                          ⚠
                        </span>
                      ) : null}
                    </td>
                    <td>{position.currentUnits}</td>
                    <td>{position.averageUnitCost}</td>
                    <td>
                      {cachedPrice ? (
                        <>
                          {cachedPrice.price}{" "}
                          <small
                            className={`priceStatus ${freshness ?? "unknown"}`}
                          >
                            {priceFreshnessLabel(freshness)}
                          </small>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {position.marketValue
                        ? formatMoneyMinor(position.marketValue)
                        : "—"}
                    </td>
                    <td
                      className={
                        position.unrealizedPnl
                          ? moneySign(position.unrealizedPnl)
                          : undefined
                      }
                    >
                      {position.unrealizedPnl
                        ? formatMoneyMinor(position.unrealizedPnl)
                        : "—"}
                    </td>
                    <td className="rowActions">
                      <Link href={`/inversiones/${position.assetId}/operacion`}>
                        Operar
                      </Link>
                      {" · "}
                      <Link href={`/inversiones/${position.assetId}/editar`}>
                        Editar
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {positions.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    Sin inversiones todavía —{" "}
                    <Link href="/inversiones/nueva">crea tu primera inversión</Link>.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {trashedInvestments.length > 0 ? (
          <details className="trashPanel">
            <summary>Papelera ({trashedInvestments.length})</summary>
            <div className="trashList">
              {trashedInvestments.map((item) => (
                <div className="trashRow" key={item.id}>
                  <span>{item.name}</span>
                  <div className="trashRowActions">
                    <form action={restoreInvestmentAction}>
                      <input name="currentUrl" type="hidden" value={currentUrl} />
                      <input name="id" type="hidden" value={item.id} />
                      <button type="submit">Restaurar</button>
                    </form>
                    <form action={hardDeleteInvestmentAction}>
                      <input name="currentUrl" type="hidden" value={currentUrl} />
                      <input name="id" type="hidden" value={item.id} />
                      <details className="confirmDelete">
                        <summary>Eliminar definitivamente</summary>
                        <button type="submit">Confirmar borrado definitivo</button>
                      </details>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </section>
    </Shell>
  );
}

