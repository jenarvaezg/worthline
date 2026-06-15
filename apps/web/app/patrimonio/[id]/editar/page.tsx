import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import {
  collectWarnings,
  getPriceFreshness,
  listScopeOptions,
  valuationMethodOfAsset,
  valuationMethodOfLiability,
} from "@worthline/domain";
import type { ValuationMethod } from "@worthline/domain";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import OperationsEditor from "../../../_components/operations-editor";
import {
  parseFormError,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "../../../intake";
import {
  confirmStatementAction,
  deleteOperationAction,
  previewStatementAction,
  recordOperationAction,
  type StatementPreviewState,
  updateInvestmentAction,
} from "../../../inversiones/actions";
import Shell from "../../../shell";
import {
  acknowledgeWarningAction,
  deleteAssetAction,
  deleteLiabilityAction,
} from "../../actions";
import { CoinCollectionSection } from "./_surfaces/coin-collection-section";
import { DebtModelSection } from "./_surfaces/debt-model-section";
import { AssetEditForm, LiabilityEditForm } from "./_surfaces/holding-forms";
import { HousingValuationSection } from "./_surfaces/housing-valuation-section";
import { StatementUploadSection } from "./_surfaces/statement-upload-section";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

export default async function EditarPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
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

    const assets = store.assets.readAssets();
    const liabilities = store.liabilities.readLiabilities();
    const overrides = store.readWarningOverrides();

    const asset = assets.find((a) => a.id === id) ?? null;
    const liability = liabilities.find((l) => l.id === id) ?? null;

    // The holding's valuation method drives which surface renders (#152, ADR 0014).
    const assetMethod = asset ? valuationMethodOfAsset(asset) : null;

    // appreciating (property): appreciation rate + market appraisals (PRD #108).
    const isAppreciating = assetMethod === "appreciating";
    const anchors = isAppreciating ? store.assets.readValuationAnchors(id) : [];
    const appreciationRate = isAppreciating
      ? store.assets.readAnnualAppreciationRate(id)
      : null;

    // A connected-source coin collection (Numista) is `derived` too, but its
    // sub-detail is its mirrored positions, not investment operations (ADR 0016).
    // Resolve the source from the asset id, then read its positions.
    const isCoinCollection = asset?.instrument === "coin_collection";
    const coinSource = isCoinCollection
      ? (store.connectedSources.listSources().find((s) => s.assetId === id) ?? null)
      : null;
    const coinPositions = coinSource
      ? store.connectedSources.readPositions(coinSource.id)
      : [];

    // derived (investment): the operations editor + its derived position (ADR 0006).
    // A coin collection is derived but routed to its own surface, so skip these.
    const isDerived = assetMethod === "derived" && !isCoinCollection;
    const investment = isDerived ? store.assets.readInvestmentAssetById(id) : null;
    const operations = isDerived ? store.operations.readOperations(id) : [];
    const priceCache = isDerived ? store.operations.readPriceCache(id) : null;
    // The coin collection's decoupled valuation freshness (PRD #166): its own
    // `numista`-source cache row, separate from the investment derived path above.
    const coinValuationCache = isCoinCollection
      ? store.operations.readPriceCache(id)
      : null;
    const position = isDerived
      ? (store.snapshots.readPositions().find((p) => p.assetId === id) ?? null)
      : null;

    // amortized / anchored: the debt-model data (PRD #109).
    const debtModel = liability ? store.liabilities.readDebtModel(id) : null;
    const amortizationPlan =
      liability && debtModel === "amortizable"
        ? store.liabilities.readAmortizationPlan(id)
        : null;
    const rateRevisions = amortizationPlan
      ? store.liabilities.readInterestRateRevisions(amortizationPlan.id)
      : [];
    const earlyRepayments = amortizationPlan
      ? store.liabilities.readEarlyRepayments(amortizationPlan.id)
      : [];
    const balanceAnchors =
      liability && (debtModel === "revolving" || debtModel === "informal")
        ? store.liabilities.readBalanceAnchors(id)
        : [];

    return {
      activeMembers: workspace.members.filter((m) => !m.disabledAt),
      amortizationPlan,
      anchors,
      appreciationRate,
      asset,
      assetMethod,
      assets: assets.filter((a) => a.type !== "investment"),
      balanceAnchors,
      coinPositions,
      coinSource,
      coinValuationCache,
      debtModel,
      earlyRepayments,
      isCoinCollection,
      investment,
      liability,
      operations,
      overrides,
      position,
      priceCache,
      rateRevisions,
      scopes,
      selectedScope,
      workspace,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const {
    activeMembers,
    amortizationPlan,
    anchors,
    appreciationRate,
    asset,
    assetMethod,
    assets,
    balanceAnchors,
    coinPositions,
    coinSource,
    coinValuationCache,
    debtModel,
    earlyRepayments,
    isCoinCollection,
    investment,
    liability,
    operations,
    overrides,
    position,
    priceCache,
    rateRevisions,
    scopes,
    selectedScope,
  } = storeData;

  if (!asset && !liability) {
    notFound();
  }

  const today = new Date().toISOString().slice(0, 10);
  const currentUrl = `/patrimonio/${id}/editar`;

  // The holding's valuation method: an asset reads it off its instrument, a
  // liability off its debt model (#152). This single value dispatches the surface.
  const method: ValuationMethod = asset
    ? assetMethod!
    : valuationMethodOfLiability(debtModel);

  const warnings = asset ? collectWarnings([asset], overrides) : [];
  const ownershipScopeMemberId =
    activeMembers.find((m) => m.id === selectedScope?.id)?.id ?? activeMembers[0]?.id;

  // Bind the holding id to the operations actions so the `derived` surface posts
  // back to this detail page (#153 collapsed the /inversiones management routes;
  // the shared investment actions now live on under app/inversiones/actions.ts
  // and the ficha is the single place operations are recorded).
  async function boundRecordOperationAction(formData: FormData) {
    "use server";
    await recordOperationAction(id, formData);
  }

  async function boundDeleteOperationAction(formData: FormData) {
    "use server";
    await deleteOperationAction(id, formData);
  }

  async function boundPreviewStatementAction(
    prev: StatementPreviewState,
    formData: FormData,
  ) {
    "use server";
    return previewStatementAction(id, prev, formData);
  }

  async function boundConfirmStatementAction(formData: FormData) {
    "use server";
    await confirmStatementAction(id, formData);
  }

  async function boundUpdateInvestmentAction(formData: FormData) {
    "use server";
    await updateInvestmentAction(id, formData);
  }

  const freshness =
    method === "derived" && priceCache
      ? getPriceFreshness(priceCache, persistence.checkedAt)
      : null;

  return (
    <Shell
      activeSection="patrimonio"
      currentPageUrl={currentUrl}
      persistence={persistence}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
      warnings={[]}
    >
      {formOk ? (
        <p className="successBand" role="status">
          {formOk}
        </p>
      ) : null}

      <section className="formPage" aria-label="Editar holding">
        <div className="panelHeader">
          <h2>Editar {asset ? "activo" : "deuda"}</h2>
          <Link href={`/patrimonio#${id}`}>← Volver</Link>
        </div>

        {/* Active warnings for this holding */}
        {warnings.length > 0 ? (
          <div className="warningBand" role="alert" aria-label="Avisos">
            {warnings.map((w) => (
              <div className="warningItem" key={`${w.entityId}-${w.code}`}>
                <span>⚠ {w.message}</span>
                {w.severity === "overrideable" ? (
                  <form action={acknowledgeWarningAction}>
                    <input name="currentUrl" type="hidden" value={currentUrl} />
                    <input name="code" type="hidden" value={w.code} />
                    <input name="entityId" type="hidden" value={id} />
                    <button className="btnSmall btnWarning" type="submit">
                      Es intencional
                    </button>
                  </form>
                ) : (
                  <span className="blockingNote">No se puede ignorar</span>
                )}
              </div>
            ))}
          </div>
        ) : null}

        {formError && formError.formId !== "operation" ? (
          <p className="errorBand" role="alert">
            {formError.message}
          </p>
        ) : null}

        {asset ? (
          <AssetEditForm
            asset={asset}
            investment={investment}
            isCoinCollection={isCoinCollection}
            members={activeMembers}
            method={method}
            scopeMemberId={ownershipScopeMemberId}
            updateInvestmentAction={boundUpdateInvestmentAction}
            values={formError?.formId === "edit" ? formError.values : {}}
          />
        ) : liability ? (
          <LiabilityEditForm
            assets={assets}
            liability={liability}
            members={activeMembers}
            scopeMemberId={ownershipScopeMemberId}
            values={formError?.formId === "edit" ? formError.values : {}}
          />
        ) : null}

        {/* ── Method-dispatched configuration surface (#152, ADR 0014) ───────── */}

        {/* coin_collection: the Numista catalogue (variant B) — derived, but its
            sub-detail is mirrored positions, not operations (PRD #160, ADR 0016). */}
        {asset && isCoinCollection ? (
          <CoinCollectionSection
            currentUrl={currentUrl}
            lastSyncAt={coinSource?.lastSyncAt ?? null}
            positions={coinPositions}
            sourceId={coinSource?.id ?? null}
            valuationFreshness={coinValuationCache?.freshnessState ?? null}
            valuationStaleReason={coinValuationCache?.staleReason ?? null}
          />
        ) : null}

        {/* derived: the investment's operations editor (the single place units change) */}
        {asset && method === "derived" && !isCoinCollection ? (
          <OperationsEditor
            assetName={asset.name}
            context={{
              ...(position ? { currentUnits: position.currentUnits } : {}),
              ...(priceCache
                ? { unitPrice: priceCache.price, priceFreshness: freshness }
                : {}),
              ...(position?.marketValue ? { marketValue: position.marketValue } : {}),
              ...(position?.unrealizedPnl
                ? { unrealizedPnl: position.unrealizedPnl }
                : {}),
            }}
            currentUrl={currentUrl}
            deleteAction={boundDeleteOperationAction}
            formError={formError}
            operations={operations}
            recordAction={boundRecordOperationAction}
            today={today}
          />
        ) : null}

        {/* derived: load operations from a broker statement (ADR 0018, #174/#176) */}
        {asset && method === "derived" && !isCoinCollection ? (
          <StatementUploadSection
            confirmAction={boundConfirmStatementAction}
            currentUrl={currentUrl}
            previewAction={boundPreviewStatementAction}
          />
        ) : null}

        {/* appreciating: the housing valuation curve + appraisals */}
        {asset && method === "appreciating" ? (
          <HousingValuationSection
            anchors={anchors}
            appreciationRate={appreciationRate}
            assetId={asset.id}
            formError={formError}
            today={today}
          />
        ) : null}

        {/* amortized / anchored: the debt-model editor (the selector fans out within) */}
        {liability ? (
          <DebtModelSection
            amortizationPlan={amortizationPlan}
            balanceAnchors={balanceAnchors}
            debtModel={debtModel}
            earlyRepayments={earlyRepayments}
            formError={formError}
            liabilityId={liability.id}
            rateRevisions={rateRevisions}
            today={today}
          />
        ) : null}

        {/* Danger zone — two-step delete */}
        <div className="dangerZone">
          <h3>Zona de peligro</h3>
          {asset ? (
            <form action={deleteAssetAction}>
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input name="id" type="hidden" value={id} />
              <details className="confirmDelete">
                <summary>Eliminar activo</summary>
                <p>El activo se moverá a la Papelera y podrás recuperarlo.</p>
                <button type="submit">Confirmar eliminación</button>
              </details>
            </form>
          ) : (
            <form action={deleteLiabilityAction}>
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input name="id" type="hidden" value={id} />
              <details className="confirmDelete">
                <summary>Eliminar deuda</summary>
                <p>La deuda se moverá a la Papelera y podrás recuperarla.</p>
                <button type="submit">Confirmar eliminación</button>
              </details>
            </form>
          )}
        </div>
      </section>
    </Shell>
  );
}
