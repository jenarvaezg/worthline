import { isDemoMode } from "@web/demo/write-guard";
import { isPremiumIngestionAllowed } from "@web/entitlements/effective-plan";
import { PAYWALL_STATEMENT_MESSAGE } from "@web/entitlements/paywall-copy";
import { PremiumNotice } from "@web/entitlements/premium-notice";
import { readEffectivePlan } from "@web/entitlements/read-effective-plan";
import { buildCurrentUrlFor, parseFormError, resolveOkMessage } from "@web/intake";
import { resolvePageShell } from "@web/page-shell";
import { readStoreTarget } from "@web/read-store-target";
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

  // Preserve the workspace guard (redirect to /empezar when uninitialized) that
  // the shared layout also enforces; the read is request-cached (#1190).
  await resolvePageShell({ searchParams: resolvedSearchParams });

  // Statement import is premium ingestion (#1162): a free workspace sees an
  // honest reminder — reading stays open, and manual entry is always free.
  const importGated = !isPremiumIngestionAllowed(
    await readEffectivePlan(await readStoreTarget()),
  );

  return (
    <>
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

      {importGated ? <PremiumNotice message={PAYWALL_STATEMENT_MESSAGE} /> : null}

      <ImportStatementPreview
        confirmAction={confirmImportStatementAction}
        currentUrl={currentUrl}
        previewAction={previewImportStatementAction}
        readOnly={isDemo}
      />
    </>
  );
}
