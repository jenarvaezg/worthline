import { isDemoMode } from "@web/demo/write-guard";
import { parseFormError, resolveOkMessage } from "@web/intake";
import { resolvePageShell } from "@web/page-shell";
import { batchValueUpdateAction } from "@web/patrimonio/actions";
import { formatMoneyInput, isValueUpdateEligible } from "@worthline/domain";
import Link from "next/link";

import PuestaAlDiaForm, { type PuestaFieldRow } from "./puesta-al-dia-form";

export const dynamic = "force-dynamic";

export default async function PuestaAlDiaPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  // Demo skips optimistic mutations — the write-guard rejects them (§10).
  const isDemo = await isDemoMode();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);

  const { privacyMode, store } = await resolvePageShell({
    searchParams: resolvedSearchParams,
  });

  // Only hand-valued assets — derived holdings (investments, connected-source
  // coin collections) are valued from their sub-detail, never in this pass.
  const assets = (await store.assets.readAssets())
    .filter(isValueUpdateEligible)
    .sort((a, b) => {
      // Stable fallback: sort by id alphabetically for determinism
      return a.id.localeCompare(b.id);
    });
  const liabilities = await store.liabilities.readLiabilities();

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
    </>
  );
}
