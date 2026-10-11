import {
  createStandaloneIncomeAction,
  deleteIncomeAction,
  updateIncomeDeclarationAction,
} from "@web/_income/income-actions";
import { isDemoMode } from "@web/demo/write-guard";
import { buildCurrentUrlFor, parseFormError, resolveOkMessage } from "@web/intake";
import { resolvePageShell } from "@web/page-shell";
import Link from "next/link";
import { Suspense } from "react";

import { IncomesLedger } from "./incomes-ledger";
import { loadRentas } from "./load-rentas";

/**
 * Rentas — where every declared income is seen, and where one is declared without
 * inventing an asset (#1673, S2 of #1522; ADR 0108).
 *
 * A pension, a salary, a life annuity: none of them is a holding, and until this
 * surface the only door to declaring an income sat on a holding's ficha — so the
 * only way in was to make one up. Here the income stands on its own; the ficha's
 * Cobros section stays the same door with the asset already linked, and its
 * incomes are listed here too.
 *
 * Server-rendered list (the RSC read model `loadRentas`); the island only adds the
 * optimism of declaring, correcting and deleting (interaction-patterns §4).
 */

export default function RentasPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<RentasSkeleton />}>
      <RentasContent searchParams={searchParams} />
    </Suspense>
  );
}

async function RentasContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const currentUrl = buildCurrentUrlFor("/objetivos/rentas", resolvedSearchParams);
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);

  const [{ privacyMode, selectedScope, store, workspace }, isDemo] = await Promise.all([
    resolvePageShell({ searchParams: resolvedSearchParams }),
    isDemoMode(),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  // The scope on screen decides whether the card reads an income without an asset
  // (#1811) — the same scope Objetivos draws that card for.
  const { cardContext, holdingById, incomes } = await loadRentas({
    scopeId: selectedScope?.id ?? "household",
    store,
    today,
    workspace,
  });

  // A refused declaration posted without JavaScript comes back on the URL; with
  // JavaScript the refusal never leaves the island.
  const declarationError = formError?.formId === "income" ? formError : null;
  // Any other refusal (a correction posted without JavaScript, the demo guard) has
  // no form of its own on screen, so it rides the band rather than vanishing.
  const bandError = formError && formError.formId !== "income" ? formError : null;

  return (
    <div className="rentasPage">
      <Link className="actionLink rentasBack" href="/objetivos">
        ← Objetivos
      </Link>
      <header className="panelHeader">
        <h2>Rentas</h2>
        <span>pensiones, nóminas y cobros recurrentes, con o sin activo</span>
      </header>

      {bandError ? (
        <p className="errorBand" role="alert">
          {bandError.message}
        </p>
      ) : null}
      {formOk ? (
        <p className="successBand" role="status">
          {formOk}
        </p>
      ) : null}

      <p className="infoNote">
        Una renta es un importe fijo que se repite. Si la genera un activo —el alquiler de
        un piso, el cupón de un bono— se declara en la ficha de ese activo y aparece aquí
        también. Si no la genera ninguno —una pensión pública, una nómina—, se declara
        aquí, sin darla de alta como activo. Ninguna renta cambia tu patrimonio.
      </p>

      <IncomesLedger
        createAction={createStandaloneIncomeAction}
        currency={workspace.baseCurrency}
        currentUrl={currentUrl}
        deleteAction={deleteIncomeAction}
        holdingById={holdingById}
        incomes={incomes}
        initialError={declarationError?.message ?? null}
        initialValues={declarationError?.values ?? {}}
        privacyMode={privacyMode}
        readOnly={isDemo}
        cardContext={cardContext}
        today={today}
        updateAction={updateIncomeDeclarationAction}
      />
    </div>
  );
}

function RentasSkeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando rentas" className="section" role="status">
      <div className="skeletonTier" />
      <div className="skeletonTier skeletonShort" />
    </div>
  );
}
