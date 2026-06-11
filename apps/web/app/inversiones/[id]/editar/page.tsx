import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import { formatMoneyMinor, listScopeOptions } from "@worthline/domain";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import {
  buildCurrentUrlFor,
  parseFormError,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "../../../intake";
import Shell from "../../../shell";
import { deleteInvestmentAction, updateInvestmentAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EditarInversionPage({
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
    `/inversiones/${assetId}/editar`,
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
    const positions = store.readPositions();
    const position = positions.find((p) => p.assetId === assetId);

    return {
      asset,
      operations,
      position,
      scopes,
      selectedScope,
    };
  });

  if (!storeData) {
    const workspace = withStore((store) => store.readWorkspace());

    if (!workspace) {
      redirect("/empezar");
    }

    notFound();
  }

  const { asset, operations, scopes, selectedScope } = storeData;

  const editValues =
    formError?.formId === "edit" ? formError.values : {};

  // Bind asset id to the server actions
  async function boundUpdateInvestmentAction(formData: FormData) {
    "use server";
    await updateInvestmentAction(assetId, formData);
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
      <section
        className="inversionesSubpage"
        aria-label={`Editar ${asset.name}`}
      >
        <div className="panelHeader">
          <h2>Editar inversión</h2>
          <a href="/inversiones">← Inversiones</a>
        </div>

        {formOk ? (
          <p className="successBand" role="status">
            {formOk}
          </p>
        ) : null}

        {formError?.formId === "edit" ? (
          <p className="errorBand" role="alert" id="edit-error">
            {formError.message}
          </p>
        ) : null}

        <form
          action={boundUpdateInvestmentAction}
          className="stackForm inversionesForm"
        >
          <input name="currentUrl" type="hidden" value={currentUrl} />

          <label>
            Nombre <span aria-hidden="true">*</span>
            <input
              aria-label="Nombre de la inversión"
              aria-required="true"
              defaultValue={editValues["name"] ?? asset.name}
              name="name"
              required
            />
          </label>

          <label>
            Ticker / símbolo{" "}
            <small>(formato Stooq, p.ej. VWRL.UK)</small>
            <input
              aria-label="Ticker o símbolo"
              defaultValue={editValues["unitSymbol"] ?? asset.unitSymbol ?? ""}
              name="unitSymbol"
              placeholder="VWRL.UK"
            />
          </label>

          <label>
            ISIN{" "}
            <small>(opcional)</small>
            <input
              aria-label="ISIN"
              defaultValue={editValues["isin"] ?? asset.isin ?? ""}
              name="isin"
              placeholder="IE00B3RBWM25"
            />
          </label>

          <label>
            Precio manual por unidad (EUR){" "}
            <small>
              — ¿Valor estático sin cotización?{" "}
              <a href="/patrimonio/nuevo-activo">Activo manual</a>
            </small>
            <input
              aria-label="Precio actual por unidad en EUR"
              defaultValue={
                editValues["manualPricePerUnit"] ??
                asset.manualPricePerUnit ??
                ""
              }
              inputMode="decimal"
              name="manualPricePerUnit"
              placeholder="12,50"
            />
          </label>

          <button type="submit">Guardar cambios</button>
        </form>

        {/* Operations history */}
        {operations.length > 0 ? (
          <details className="recentOpsPanel" open>
            <summary>Historial de operaciones ({operations.length})</summary>
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

        {/* Two-step delete */}
        <div className="dangerZone">
          <form action={deleteInvestmentAction}>
            <input name="currentUrl" type="hidden" value="/inversiones" />
            <input name="id" type="hidden" value={assetId} />
            <details className="confirmDelete">
              <summary>Eliminar inversión</summary>
              <p>
                Eliminar moverá esta inversión a la Papelera; podrás
                restaurarla desde /inversiones.
              </p>
              <button type="submit">Confirmar eliminación</button>
            </details>
          </form>
        </div>
      </section>
    </Shell>
  );
}
