import { isDemoMode } from "@web/demo/write-guard";
import { isPremiumIngestionAllowed } from "@web/entitlements/effective-plan";
import { PAYWALL_STATEMENT_MESSAGE } from "@web/entitlements/paywall-copy";
import { PremiumNotice } from "@web/entitlements/premium-notice";
import { readEffectivePlan } from "@web/entitlements/read-effective-plan";
import FormRouteSkeleton from "@web/form-route-skeleton";
import { buildCurrentUrlFor, parseFormError, resolveOkMessage } from "@web/intake";
import { resolvePageShell } from "@web/page-shell";
import { readStoreTarget } from "@web/read-store-target";
import { IMPORT_DOCUMENT_VIEW_PARAM, readViewParam } from "@web/view-state";
import { Suspense } from "react";
import { confirmImportStatementAction, previewImportStatementAction } from "./actions";
import { ImportLaneTabs } from "./import-lane-tabs";
import { ImportSchedulePreview } from "./import-schedule-preview";
import { ImportStatementPreview } from "./import-statement-preview";
import {
  confirmImportScheduleAction,
  previewImportScheduleAction,
} from "./schedule-actions";
import { readScheduleImportTargets } from "./schedule-import-preview";

/**
 * "Importar extracto" — the portfolio-level import flow (PRD #669 S2, #673, ADR
 * 0055). One door, two readers (#1406): a statement of investment movements, and
 * a bank's cuadro de amortización. Both lanes are server-rendered and the tab
 * island shows the active one; they share the entry and the preview→confirm
 * shape, and nothing else — a movement is a book event, an amortization schedule
 * is the output of a generative model.
 */
export default function ImportarExtractoPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<FormRouteSkeleton label="Cargando importar extracto" />}>
      <ImportarExtractoContent searchParams={searchParams} />
    </Suspense>
  );
}

export async function ImportarExtractoContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
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
  const shell = await resolvePageShell({ searchParams: resolvedSearchParams });

  // Both lanes are rendered server-side and the tab island shows one; the schedule
  // lane needs to know which debts even have a plan to write over (#1406).
  const scheduleTargets = await readScheduleImportTargets(shell.store);
  const initialDocument = readViewParam(
    `?${new URLSearchParams(
      Object.entries(resolvedSearchParams ?? {}).flatMap(([key, value]) =>
        typeof value === "string" ? [[key, value] as [string, string]] : [],
      ),
    ).toString()}`,
    IMPORT_DOCUMENT_VIEW_PARAM,
  );

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
          Un extracto de operaciones reconstruye tu cartera; el cuadro de tu banco
          reconstruye la historia de una hipoteca
        </span>
      </section>

      {importGated ? <PremiumNotice message={PAYWALL_STATEMENT_MESSAGE} /> : null}

      <ImportLaneTabs
        basePath="/patrimonio/importar-extracto"
        cuadro={
          <ImportSchedulePreview
            confirmAction={confirmImportScheduleAction}
            currentUrl={currentUrl}
            previewAction={previewImportScheduleAction}
            readOnly={isDemo}
            targets={scheduleTargets}
          />
        }
        initialDocument={initialDocument}
        operaciones={
          <ImportStatementPreview
            confirmAction={confirmImportStatementAction}
            currentUrl={currentUrl}
            previewAction={previewImportStatementAction}
            readOnly={isDemo}
          />
        }
      />
    </>
  );
}
