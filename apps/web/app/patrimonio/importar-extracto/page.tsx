import { isDemoMode } from "@web/demo/write-guard";
import { buildCurrentUrlFor, parseFormError, resolveOkMessage } from "@web/intake";
import { resolvePageShell } from "@web/page-shell";
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
  const isDemo = await isDemoMode();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  const currentUrl = buildCurrentUrlFor(
    "/patrimonio/importar-extracto",
    resolvedSearchParams,
  );

  const { persistence, scopes, selectedScope } = await resolvePageShell({
    searchParams: resolvedSearchParams,
  });

  return (
    <Shell
      activeSection="patrimonio"
      currentPageUrl={currentUrl}
      persistence={persistence}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
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
