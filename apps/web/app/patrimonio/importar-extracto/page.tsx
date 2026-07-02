import { bootstrapHealthcheck, withStore } from "@web/store";
import { collectWarnings, listScopeOptions } from "@worthline/domain";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  buildCurrentUrlFor,
  parseFormError,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import { isDemoMode } from "@web/demo/write-guard";
import Shell from "@web/shell";
import { confirmImportStatementAction, previewImportStatementAction } from "./actions";
import { ImportStatementPreview } from "./import-statement-preview";

export const dynamic = "force-dynamic";

/**
 * "Importar extracto" — the portfolio-level statement import flow (PRD #669
 * S2, #673, ADR 0055). Its own isolated route/surface: S3 (#674) only wires
 * links to it from the portfolio page and the add-holding wizard.
 */
export default async function ImportarExtractoPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = await bootstrapHealthcheck();
  const isDemo = await isDemoMode();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  const currentUrl = buildCurrentUrlFor(
    "/patrimonio/importar-extracto",
    resolvedSearchParams,
  );

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  const storeData = await withStore(async (store) => {
    const workspace = await store.workspace.readWorkspace();
    if (!workspace) return null;

    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];
    const assets = await store.assets.readAssets();
    const overrides = await store.readWarningOverrides();

    return { scopes, selectedScope, warnings: collectWarnings(assets, overrides) };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const { scopes, selectedScope, warnings } = storeData;

  return (
    <Shell
      activeSection="patrimonio"
      currentPageUrl={currentUrl}
      persistence={persistence}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
      warnings={warnings}
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

      <section className="panelHeader">
        <h2>Importar extracto</h2>
        <span>
          Un extracto con cualquier mezcla de ISINs reconstruye tu cartera de una vez
        </span>
      </section>

      <ImportStatementPreview
        confirmAction={confirmImportStatementAction}
        currentUrl={currentUrl}
        previewAction={previewImportStatementAction}
        readOnly={isDemo}
      />
    </Shell>
  );
}
