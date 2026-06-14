import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import { getPriceFreshness, listScopeOptions } from "@worthline/domain";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import OperationsEditor from "../../../_components/operations-editor";
import {
  buildCurrentUrlFor,
  parseFormError,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "../../../intake";
import Shell from "../../../shell";
import { deleteOperationAction, recordOperationAction } from "../../actions";

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
    const workspace = store.workspace.readWorkspace();

    if (!workspace) return null;

    const asset = store.assets.readInvestmentAssetById(assetId);

    if (!asset) return null;

    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];

    const operations = store.operations.readOperations(assetId);
    const priceCache = store.operations.readPriceCache(assetId);

    // Latest position: re-derive from operations + price
    const positions = store.snapshots.readPositions();
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
    const workspace = withStore((store) => store.workspace.readWorkspace());

    if (!workspace) {
      redirect("/empezar");
    }

    notFound();
  }

  const { asset, operations, position, priceCache, scopes, selectedScope } = storeData;

  const today = new Date().toISOString().slice(0, 10);
  const freshness = priceCache
    ? getPriceFreshness(priceCache, persistence.checkedAt)
    : null;

  // Bind the route asset id to the server actions
  async function boundRecordOperationAction(formData: FormData) {
    "use server";
    await recordOperationAction(assetId, formData);
  }

  async function boundDeleteOperationAction(formData: FormData) {
    "use server";
    await deleteOperationAction(assetId, formData);
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
      <div className="inversionesSubpage">
        <div className="panelHeader">
          <h2>Registrar operación</h2>
          <a href="/inversiones">← Inversiones</a>
        </div>

        {formOk ? (
          <p className="successBand" role="status">
            {formOk}
          </p>
        ) : null}

        <OperationsEditor
          assetName={asset.name}
          context={{
            ...(position ? { currentUnits: position.currentUnits } : {}),
            ...(priceCache
              ? { unitPrice: priceCache.price, priceFreshness: freshness }
              : {}),
            ...(position?.marketValue ? { marketValue: position.marketValue } : {}),
          }}
          currentUrl={currentUrl}
          deleteAction={boundDeleteOperationAction}
          formError={formError}
          operations={operations}
          recordAction={boundRecordOperationAction}
          today={today}
        />
      </div>
    </Shell>
  );
}
