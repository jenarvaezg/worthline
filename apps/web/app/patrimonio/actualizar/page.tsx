import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import {
  formatMoneyInput,
  formatMoneyMinor,
  isValueUpdateEligible,
  listScopeOptions,
} from "@worthline/domain";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  parseFormError,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import Shell from "@web/shell";
import { batchValueUpdateAction } from "@web/patrimonio/actions";

export const dynamic = "force-dynamic";

export default async function PuestaAlDiaPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = runBootstrapHealthcheck();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  const storeData = withStore((store) => {
    const workspace = store.workspace.readWorkspace();

    if (!workspace) {
      return null;
    }

    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];

    return {
      // Only hand-valued assets — derived holdings (investments, connected-source
      // coin collections) are valued from their sub-detail, never in this pass.
      assets: store.assets
        .readAssets()
        .filter(isValueUpdateEligible)
        .sort((a, b) => {
          // Stable fallback: sort by id alphabetically for determinism
          return a.id.localeCompare(b.id);
        }),
      liabilities: store.liabilities.readLiabilities(),
      scopes,
      selectedScope,
      workspace,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const { assets, liabilities, scopes, selectedScope } = storeData;

  return (
    <Shell
      activeSection="patrimonio"
      currentPageUrl="/patrimonio/actualizar"
      persistence={persistence}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
      warnings={[]}
    >
      {formError ? (
        <p className="errorBand" role="alert">
          {formError.message}
        </p>
      ) : null}

      {formOk ? (
        <p className="successBand" role="status">
          {formOk}
        </p>
      ) : null}

      <section className="puestaAlDia" aria-label="Puesta al día">
        <div className="panelHeader">
          <h2>Puesta al día</h2>
          <span>Actualiza todos los valores manuales de una vez</span>
        </div>

        {assets.length === 0 && liabilities.length === 0 ? (
          <p className="emptyLine">
            Sin activos ni deudas manuales.{" "}
            <Link href="/patrimonio/anadir">Añadir holding →</Link>
          </p>
        ) : (
          <form action={batchValueUpdateAction} className="stackForm">
            <input name="currentUrl" type="hidden" value="/patrimonio/actualizar" />

            {assets.length > 0 ? (
              <fieldset className="puestaFieldset">
                <legend>Activos manuales</legend>
                {assets.map((asset) => {
                  const fieldError =
                    formError?.formId === asset.id ? formError.message : null;
                  const fieldValue =
                    formError?.formId === asset.id
                      ? (formError.values["currentValue"] ?? "")
                      : formatMoneyInput(asset.currentValue.amountMinor);

                  return (
                    <div className="puestaRow" key={asset.id}>
                      <label htmlFor={`val_${asset.id}`}>
                        <span className="puestaName">{asset.name}</span>
                        <small className="puestaTier">{asset.liquidityTier}</small>
                      </label>
                      <div className="puestaInput">
                        <input
                          defaultValue={fieldValue}
                          id={`val_${asset.id}`}
                          inputMode="decimal"
                          name={`val_${asset.id}`}
                          aria-label={`Valor de ${asset.name} en EUR`}
                          placeholder="Valor EUR"
                        />
                        <small className="puestaCurrent">
                          Actual: {formatMoneyMinor(asset.currentValue)}
                        </small>
                        {fieldError ? (
                          <p className="formError" role="alert">
                            {fieldError}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </fieldset>
            ) : null}

            {liabilities.length > 0 ? (
              <fieldset className="puestaFieldset">
                <legend>Deudas</legend>
                {liabilities.map((liability) => {
                  const fieldError =
                    formError?.formId === liability.id ? formError.message : null;
                  const fieldValue =
                    formError?.formId === liability.id
                      ? (formError.values["balance"] ?? "")
                      : formatMoneyInput(liability.currentBalance.amountMinor);

                  return (
                    <div className="puestaRow" key={liability.id}>
                      <label htmlFor={`val_${liability.id}`}>
                        <span className="puestaName">{liability.name}</span>
                        <small className="puestaTier">
                          {liability.type === "mortgage" ? "Hipoteca" : "Deuda"}
                        </small>
                      </label>
                      <div className="puestaInput">
                        <input
                          defaultValue={fieldValue}
                          id={`val_${liability.id}`}
                          inputMode="decimal"
                          name={`val_${liability.id}`}
                          aria-label={`Saldo de ${liability.name} en EUR`}
                          placeholder="Saldo EUR"
                        />
                        <small className="puestaCurrent">
                          Actual: {formatMoneyMinor(liability.currentBalance)}
                        </small>
                        {fieldError ? (
                          <p className="formError" role="alert">
                            {fieldError}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </fieldset>
            ) : null}

            <div className="puestaFooter">
              <button type="submit">Guardar todo</button>
              <Link href="/patrimonio">Cancelar</Link>
            </div>
          </form>
        )}
      </section>
    </Shell>
  );
}
