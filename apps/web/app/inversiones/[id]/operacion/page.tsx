import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import {
  formatMoneyMinor,
  getPriceFreshness,
  listScopeOptions,
} from "@worthline/domain";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import {
  buildCurrentUrlFor,
  parseFormError,
  parseScopeCookie,
  priceFreshnessLabel,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "../../../intake";
import Shell from "../../../shell";
import { recordOperationAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function OperacionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: assetId } = await params;
  const resolvedSearchParams = await searchParams;
  const persistence = runBootstrapHealthcheck();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  const currentUrl = buildCurrentUrlFor(
    `/inversiones/${assetId}/operacion`,
    resolvedSearchParams,
  );

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  const storeData = withStore((store) => {
    const workspace = store.readWorkspace();

    if (!workspace) return null;

    const asset = store.readInvestmentAssetById(assetId);

    if (!asset) return null;

    const scopes = listScopeOptions(workspace);
    const selectedScope =
      scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];

    const operations = store.readOperations(assetId);
    const priceCache = store.readPriceCache(assetId);

    // Latest position: re-derive from operations + price
    const positions = store.readPositions();
    const position = positions.find((p) => p.assetId === assetId);

    return {
      asset,
      operations,
      position,
      priceCache,
      scopes,
      selectedScope,
    };
  });

  if (!storeData) {
    // workspace missing → empezar; asset missing → 404
    const workspace = withStore((store) => store.readWorkspace());

    if (!workspace) {
      redirect("/empezar");
    }

    notFound();
  }

  const { asset, operations, position, priceCache, scopes, selectedScope } =
    storeData;

  const today = new Date().toISOString().slice(0, 10);
  const freshness = priceCache
    ? getPriceFreshness(priceCache, persistence.checkedAt)
    : null;

  const operationValues =
    formError?.formId === "operation" ? formError.values : {};

  // Bind the route asset id to the server action
  async function boundRecordOperationAction(formData: FormData) {
    "use server";
    await recordOperationAction(assetId, formData);
  }

  return (
    <Shell
      activeSection="inversiones"
      currentPageUrl={currentUrl}
      persistence={persistence}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
      warnings={[]}
    >
      <section className="inversionesSubpage" aria-label="Registrar operación">
        <div className="panelHeader">
          <h2>Registrar operación</h2>
          <a href="/inversiones">← Inversiones</a>
        </div>

        {/* Context header: name + current state — no JS needed to verify a sell */}
        <div className="operacionContext">
          <span className="contextLabel">Inversión</span>
          <strong>{asset.name}</strong>
          {position ? (
            <>
              <span className="contextLabel">Unidades actuales</span>
              <span>{position.currentUnits}</span>
              {priceCache ? (
                <>
                  <span className="contextLabel">Último precio</span>
                  <span>
                    {priceCache.price}{" "}
                    <small
                      className={`priceStatus ${freshness ?? "unknown"}`}
                    >
                      {priceFreshnessLabel(freshness)}
                    </small>
                  </span>
                </>
              ) : null}
              {position.marketValue ? (
                <>
                  <span className="contextLabel">Valor actual</span>
                  <span>{formatMoneyMinor(position.marketValue)}</span>
                </>
              ) : null}
            </>
          ) : (
            <span className="emptyLine">Sin operaciones previas</span>
          )}
        </div>

        {formOk ? (
          <p className="successBand" role="status">
            {formOk}
          </p>
        ) : null}

        {formError?.formId === "operation" ? (
          <p className="errorBand" role="alert" id="operation-error">
            {formError.message}
          </p>
        ) : null}

        <form
          action={boundRecordOperationAction}
          className="stackForm inversionesForm"
        >
          <input name="currentUrl" type="hidden" value={currentUrl} />

          <label>
            Tipo
            <select
              defaultValue={operationValues["kind"] ?? "buy"}
              name="kind"
            >
              <option value="buy">Compra</option>
              <option value="sell">Venta</option>
            </select>
          </label>

          <label>
            Fecha
            <input
              aria-label="Fecha de ejecución"
              defaultValue={operationValues["executedAt"] ?? today}
              name="executedAt"
              type="date"
            />
          </label>

          <label>
            Unidades <span aria-hidden="true">*</span>
            <input
              aria-label="Unidades"
              aria-required="true"
              defaultValue={operationValues["units"]}
              inputMode="decimal"
              name="units"
              placeholder="10"
            />
          </label>

          <label>
            Precio por unidad (EUR) <span aria-hidden="true">*</span>
            <input
              aria-label="Precio por unidad en EUR"
              aria-required="true"
              defaultValue={operationValues["pricePerUnit"]}
              inputMode="decimal"
              name="pricePerUnit"
              placeholder="100,00"
            />
          </label>

          <label>
            Comisiones (EUR)
            <input
              aria-label="Comisiones en EUR"
              defaultValue={operationValues["fees"] ?? "0"}
              inputMode="decimal"
              name="fees"
              placeholder="0"
            />
          </label>

          <button type="submit">Registrar operación</button>
        </form>

        {operations.length > 0 ? (
          <details className="recentOpsPanel" open>
            <summary>
              Operaciones recientes ({operations.length})
            </summary>
            <div className="tableScroll">
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Tipo</th>
                    <th>Unidades</th>
                    <th>Precio/u</th>
                    <th>Comisiones</th>
                  </tr>
                </thead>
                <tbody>
                  {[...operations]
                    .sort((a, b) => b.executedAt.localeCompare(a.executedAt))
                    .slice(0, 10)
                    .map((op) => (
                      <tr key={op.id}>
                        <td>{op.executedAt}</td>
                        <td>{op.kind === "buy" ? "Compra" : "Venta"}</td>
                        <td>{op.units}</td>
                        <td>{op.pricePerUnit}</td>
                        <td>
                          {op.feesMinor > 0
                            ? formatMoneyMinor({
                                amountMinor: op.feesMinor,
                                currency: op.currency,
                              })
                            : "—"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
      </section>
    </Shell>
  );
}

