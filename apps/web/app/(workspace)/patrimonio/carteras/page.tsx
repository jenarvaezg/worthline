import { buildCurrentUrlFor, parseFormError, resolveOkMessage } from "@web/intake";
import { resolvePageShell } from "@web/page-shell";
import { PendingSubmit } from "@web/pending-submit";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import Link from "next/link";
import { Suspense } from "react";

import { createManagedPortfolioAction } from "./carteras-actions";
import { portfolioListRowView } from "./carteras-view";
import { loadCarteras } from "./load-carteras";

/**
 * Carteras gestionadas — índice y alta (ADR 0085, #1547).
 *
 * Server-rendered figures end to end: the derived totals come from the same
 * curve-valued ledger the board reads, and the alta is a plain form + Server
 * Action. Creating a cartera never changes net worth by a céntimo — it only
 * names a group of holdings that already sum — and lands on the new ficha,
 * where members get assigned.
 */

export default function CarterasPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<CarterasSkeleton />}>
      <CarterasContent searchParams={searchParams} />
    </Suspense>
  );
}

async function CarterasContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const currentUrl = buildCurrentUrlFor("/patrimonio/carteras", resolvedSearchParams);
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);

  const { privacyMode, selectedScope, store, workspace } = await resolvePageShell({
    searchParams: resolvedSearchParams,
  });

  const today = new Date().toISOString().slice(0, 10);
  const model = await loadCarteras({
    baseCurrency: workspace.baseCurrency,
    scopeId: selectedScope?.id,
    store,
    today,
  });

  const fmt = (amountMinor: number) =>
    formatMoneyMinorPrivacy(
      { amountMinor, currency: workspace.baseCurrency },
      privacyMode,
    );

  const rows = model.portfolios.map((portfolio) =>
    portfolioListRowView({
      publicIdByPortfolio: model.publicIdByPortfolio,
      portfolio,
      valueMinorByHoldingId: model.valueMinorByHoldingId,
    }),
  );

  const createValues = formError?.formId === "cartera" ? formError.values : {};

  return (
    <div className="carterasPage section">
      <header className="panelHeader">
        <h2>Carteras gestionadas</h2>
        <span>«estos siete fondos son uno» — la agrupación que tu gestor te enseña</span>
      </header>

      {formError && !formError.formId ? (
        <p className="errorBand" role="alert">
          {formError.message}
        </p>
      ) : null}
      {formOk ? (
        <p className="successBand" role="status">
          {formOk}
        </p>
      ) : null}

      <section aria-label="Tus carteras gestionadas" className="section">
        <div className="panelHeader">
          <h3>Tus carteras</h3>
          <span>
            {rows.length} {rows.length === 1 ? "cartera" : "carteras"}
          </span>
        </div>

        {!selectedScope ? (
          <p className="muted">Elige un ámbito para ver sus carteras.</p>
        ) : rows.length === 0 ? (
          <p className="muted">
            Aún no hay carteras en este ámbito. Una cartera gestionada no añade ni quita
            patrimonio: nombra un grupo de holdings que ya suman, les añade su efectivo y
            enseña su composición como la enseña tu gestor.
          </p>
        ) : (
          <ul className="carterasList">
            {rows.map((row) => (
              <li className="carterasRow" key={row.id}>
                <div className="carterasRowMain">
                  {row.href ? (
                    <Link href={row.href}>
                      <strong>{row.name}</strong>
                    </Link>
                  ) : (
                    <strong>{row.name}</strong>
                  )}
                  <span className="muted">
                    {row.provider ? ` · ${row.provider}` : ""} · {row.memberCount}{" "}
                    {row.memberCount === 1 ? "miembro" : "miembros"}
                  </span>
                </div>
                <span className="carterasRowTotal">{fmt(row.totalMinor)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="createBlock">
        <div className="memberProfileLabel">Nueva cartera gestionada</div>
        {!selectedScope ? (
          <p className="muted">Elige un ámbito arriba antes de crear una cartera.</p>
        ) : (
          <form
            action={createManagedPortfolioAction}
            className="stackForm"
            id="carterasCreateForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="scopeId" type="hidden" value={selectedScope.id} />
            {formError?.formId === "cartera" ? (
              <p className="formError" role="alert">
                {formError.message}
              </p>
            ) : null}
            <label>
              Nombre
              <input
                defaultValue={createValues.name}
                name="name"
                placeholder="Cartera Indexada Metal"
              />
            </label>
            <label>
              Gestor (opcional)
              <input
                defaultValue={createValues.provider}
                name="provider"
                placeholder="MyInvestor, Indexa…"
              />
            </label>
            <label>
              Valor de mercado de la cartera, sin el efectivo (opcional,{" "}
              {workspace.baseCurrency})
              <input
                defaultValue={createValues.declaredValue}
                inputMode="decimal"
                name="declaredValue"
                placeholder="1.497,37"
              />
            </label>
            <p className="muted">
              Si no te apetece enumerar sus fondos ahora, teclea solo el valor de mercado
              que lees en la app de tu gestor (el de los fondos, sin la caja): la cartera
              nace con una fila «(sin detallar)» por ese importe, así que tu patrimonio la
              cuenta entera desde el primer minuto. Cuando vayas añadiendo los fondos
              reales, su ficha te dirá cuánto conviene dejar en esa fila. Si prefieres
              detallarla ya, déjalo vacío y asigna los miembros en su ficha.
            </p>
            <p className="muted">
              En ambos casos se le añade su holding de efectivo (0 €), como el que ves en
              la app del gestor mientras la aportación espera a invertirse.
            </p>
            <PendingSubmit pendingLabel="Creando…">Crear cartera</PendingSubmit>
          </form>
        )}
      </div>
    </div>
  );
}

function CarterasSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Cargando carteras"
      className="section"
      role="status"
    >
      <div className="skeletonTier" />
      <div className="skeletonTier skeletonShort" />
    </div>
  );
}
