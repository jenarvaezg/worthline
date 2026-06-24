import { bootstrapHealthcheck, withStore } from "@web/store";
import {
  formatMoneyInput,
  isValueUpdateEligible,
  listScopeOptions,
} from "@worthline/domain";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  parseFormError,
  parsePrivacyCookie,
  parseScopeCookie,
  resolveOkMessage,
  PRIVACY_COOKIE_NAME,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import { isDemoMode } from "@web/demo/write-guard";
import Shell from "@web/shell";
import { batchValueUpdateAction } from "@web/patrimonio/actions";

import PuestaAlDiaForm, { type PuestaFieldRow } from "./puesta-al-dia-form";

export const dynamic = "force-dynamic";

export default async function PuestaAlDiaPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = await bootstrapHealthcheck();
  // Demo skips optimistic mutations — the write-guard rejects them (§10).
  const isDemo = await isDemoMode();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);
  const privacyMode = parsePrivacyCookie(jar.get(PRIVACY_COOKIE_NAME)?.value);

  const storeData = await withStore(async (store) => {
    const workspace = await store.workspace.readWorkspace();

    if (!workspace) {
      return null;
    }

    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];

    return {
      // Only hand-valued assets — derived holdings (investments, connected-source
      // coin collections) are valued from their sub-detail, never in this pass.
      assets: (await store.assets.readAssets())
        .filter(isValueUpdateEligible)
        .sort((a, b) => {
          // Stable fallback: sort by id alphabetically for determinism
          return a.id.localeCompare(b.id);
        }),
      liabilities: await store.liabilities.readLiabilities(),
      scopes,
      selectedScope,
      workspace,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const { assets, liabilities, scopes, selectedScope } = storeData;

  const currency =
    assets[0]?.currentValue.currency ?? liabilities[0]?.currentBalance.currency ?? "EUR";

  // Project each holding to the field shape the island renders. The per-field error
  // + preserved value (after an error redirect) is resolved here, server-side.
  const assetRows: PuestaFieldRow[] = assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    subLabel: asset.liquidityTier,
    inputLabel: `Valor de ${asset.name} en EUR`,
    placeholder: "Valor EUR",
    currentValueMinor: asset.currentValue.amountMinor,
    defaultInput:
      formError?.formId === asset.id
        ? (formError.values["currentValue"] ?? "")
        : formatMoneyInput(asset.currentValue.amountMinor),
    fieldError: formError?.formId === asset.id ? formError.message : null,
  }));

  const liabilityRows: PuestaFieldRow[] = liabilities.map((liability) => ({
    id: liability.id,
    name: liability.name,
    subLabel: liability.type === "mortgage" ? "Hipoteca" : "Deuda",
    inputLabel: `Saldo de ${liability.name} en EUR`,
    placeholder: "Saldo EUR",
    currentValueMinor: liability.currentBalance.amountMinor,
    defaultInput:
      formError?.formId === liability.id
        ? (formError.values["balance"] ?? "")
        : formatMoneyInput(liability.currentBalance.amountMinor),
    fieldError: formError?.formId === liability.id ? formError.message : null,
  }));

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
          <PuestaAlDiaForm
            action={batchValueUpdateAction}
            assets={assetRows}
            currency={currency}
            liabilities={liabilityRows}
            privacyMode={privacyMode}
            readOnly={isDemo}
          />
        )}
      </section>
    </Shell>
  );
}
