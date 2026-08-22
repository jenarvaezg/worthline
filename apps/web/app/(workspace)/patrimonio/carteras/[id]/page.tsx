import { ChipChoice } from "@web/chip-choice";
import {
  holdingPublicIdIndex,
  managedPortfolioPublicIdIndex,
  managedPortfoliosIndexHref,
  resolveManagedPortfolioRoute,
} from "@web/holding-route";
import { buildCurrentUrlFor, parseFormError, resolveOkMessage } from "@web/intake";
import { resolvePageShell } from "@web/page-shell";
import {
  deleteManagedPortfolioAction,
  updateManagedPortfolioAction,
} from "@web/patrimonio/carteras/carteras-actions";
import {
  managedPortfolioMemberOptions,
  portfolioCompositionView,
} from "@web/patrimonio/carteras/carteras-view";
import { loadCarteras } from "@web/patrimonio/carteras/load-carteras";
import { PendingSubmit } from "@web/pending-submit";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

/**
 * Ficha de una cartera gestionada (ADR 0085, #1547) — addressed by its public
 * `wl_prt_…` id only (ADR 0069 discipline), like every holding ficha.
 *
 * Everything is derived on read: the total is the sum of its members + efectivo
 * (the same curve-valued figures the board prints), the composition shows each
 * member's weight, and the witness balance arrives in S4 — nothing here claims
 * a return (S6) or a declared saldo yet.
 */

export default function ManagedPortfolioFichaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<FichaSkeleton />}>
      <FichaContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function FichaContent({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
}) {
  const [{ id: routeId }, resolvedSearchParams] = await Promise.all([
    params,
    searchParams ?? Promise.resolve({}),
  ]);
  const currentUrl = buildCurrentUrlFor(
    `/patrimonio/carteras/${routeId}`,
    resolvedSearchParams,
  );
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);

  const { privacyMode, store, workspace } = await resolvePageShell({
    searchParams: resolvedSearchParams,
  });

  const today = new Date().toISOString().slice(0, 10);
  const model = await loadCarteras({
    baseCurrency: workspace.baseCurrency,
    scopeId: undefined,
    store,
    today,
  });

  // One registry read feeds both indexes (route resolution + member links).
  const publicIdRows = await store.agentView.readPublicIds();
  const internalId = resolveManagedPortfolioRoute(
    routeId,
    managedPortfolioPublicIdIndex(publicIdRows),
  );
  const portfolio = internalId
    ? model.allPortfolios.find((candidate) => candidate.id === internalId)
    : undefined;
  if (!portfolio) {
    notFound();
  }

  const composition = portfolioCompositionView({
    nameById: model.nameById,
    portfolio,
    publicIdByHolding: Object.fromEntries(
      holdingPublicIdIndex(publicIdRows).publicByInternal,
    ),
    typeByHoldingId: model.typeByHoldingId,
    valueMinorByHoldingId: model.valueMinorByHoldingId,
  });

  const fmt = (amountMinor: number) =>
    formatMoneyMinorPrivacy(
      { amountMinor, currency: workspace.baseCurrency },
      privacyMode,
    );

  // Members editable here: the live manual investments this portfolio may hold
  // (its own included; holdings of OTHER portfolios hidden — membership is
  // exclusive). The cash sibling never appears: it is the portfolio's plumbing.
  const options = managedPortfolioMemberOptions({
    assets: model.assets,
    memberIdsByPortfolio: model.memberIdsByPortfolio,
    portfolioId: portfolio.id,
  });

  const investmentMembers = portfolio.holdingIds.filter(
    (holdingId) => model.typeByHoldingId.get(holdingId) !== "cash",
  );
  // Only chips that RENDER can be preselected: a member whose holding died has
  // no chip to uncheck, so preselecting its id would make every save submit a
  // trashed holding and bounce forever. It leaves on the next save instead —
  // the note below says so.
  const selectableIds = new Set(options.map((option) => option.id));

  const errorFor = formError?.formId === `cartera-${portfolio.id}` ? formError : null;
  const editValues = errorFor?.values ?? {};
  const preservedIds = editValues.holdingIds
    ? editValues.holdingIds.split(",").filter(Boolean)
    : null;

  return (
    <div className="carterasPage section">
      <p className="carterasBack">
        <Link href={managedPortfoliosIndexHref()}>← Carteras gestionadas</Link>
      </p>

      <header className="panelHeader">
        <h2>{portfolio.name}</h2>
        <span>
          {portfolio.provider ? `${portfolio.provider} · ` : ""}
          valor derivado de sus miembros — el saldo declarado llega con el testigo (S4)
        </span>
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

      <section aria-label="Valor de la cartera" className="heroPanel carterasHero">
        <div className="headline">
          <span>Total derivado</span>
          <strong>{fmt(composition.totalMinor)}</strong>
        </div>
        <p className="muted">
          {composition.rows.length + composition.unknownMemberIds.length}{" "}
          {composition.rows.length + composition.unknownMemberIds.length === 1
            ? "miembro"
            : "miembros"}
          {" · "}la suma de sus holdings y su efectivo. Crear o editar la cartera nunca
          mueve tu patrimonio bruto: los miembros ya sumaban.
          {model.excludedForeignCount > 0
            ? ` ${model.excludedForeignCount} holding${
                model.excludedForeignCount === 1 ? "" : "s"
              } en otra divisa sin cambio honesto hoy no ${
                model.excludedForeignCount === 1 ? "entra" : "entran"
              } en esta suma.`
            : ""}
        </p>
      </section>

      <section aria-label="Composición" className="section">
        <div className="panelHeader">
          <h3>Composición</h3>
          <span>peso de cada miembro sobre el total</span>
        </div>

        {composition.rows.length === 0 ? (
          <p className="muted">Sin miembros con valor todavía.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Miembro</th>
                <th scope="col">Peso</th>
                <th scope="col">Valor</th>
              </tr>
            </thead>
            <tbody>
              {composition.rows.map((row) => (
                <tr key={row.holdingId}>
                  <td>
                    {row.href ? <Link href={row.href}>{row.label}</Link> : row.label}
                    {row.isCash ? " · efectivo" : ""}
                  </td>
                  <td className="carterasWeight">
                    {row.weight == null
                      ? "—"
                      : `${(row.weight * 100).toFixed(1).replace(".", ",")} %`}
                  </td>
                  <td>{fmt(row.valueMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {composition.unknownMemberIds.length > 0 ? (
          <p className="muted">
            {composition.unknownMemberIds.length === 1
              ? "1 miembro marcado ya no está vivo: no suma al total, y al guardar esta ficha deja de ser miembro."
              : `${composition.unknownMemberIds.length} miembros marcados ya no están vivos: no suman al total, y al guardar esta ficha dejan de ser miembros.`}
          </p>
        ) : null}
      </section>

      <section
        aria-label="Miembros"
        className="section"
        id={`portfolioEdit-${portfolio.id}`}
      >
        <div className="panelHeader">
          <h3>Miembros</h3>
          <span>asigna los fondos que vivan dentro de esta cartera</span>
        </div>

        <form action={updateManagedPortfolioAction} className="stackForm">
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="portfolioId" type="hidden" value={portfolio.id} />
          {errorFor ? (
            <p className="formError" role="alert">
              {errorFor.message}
            </p>
          ) : null}
          <label>
            Nombre
            <input defaultValue={editValues.name ?? portfolio.name} name="name" />
          </label>
          <label>
            Gestor (opcional)
            <input
              defaultValue={editValues.provider ?? portfolio.provider ?? ""}
              name="provider"
            />
          </label>
          <span className="memberProfileLabel">Elige qué fondos forman la cartera</span>
          {options.length === 0 ? (
            <p className="muted">
              No hay inversiones manuales vivas disponibles para asignar. Da de alta un
              fondo y vuelve.
            </p>
          ) : (
            <ChipChoice
              name="holdingIds"
              options={options}
              selectedIds={(preservedIds ?? investmentMembers).filter((holdingId) =>
                selectableIds.has(holdingId),
              )}
            />
          )}
          <p className="muted">
            Solo inversiones manuales y vivas pueden ser miembros (las de fuente
            conectada, de momento, no). Una posición solo puede estar en una cartera. El
            efectivo de la cartera no se quita de aquí: es suya desde el alta.
          </p>
          <PendingSubmit pendingLabel="Guardando…">Guardar cartera</PendingSubmit>
        </form>

        <form action={deleteManagedPortfolioAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="portfolioId" type="hidden" value={portfolio.id} />
          <details suppressHydrationWarning className="confirmDelete">
            <summary>Eliminar cartera</summary>
            <PendingSubmit pendingLabel="Borrando…">Confirmar borrado</PendingSubmit>
          </details>
          <p className="muted">
            Disuelve el grupo: ningún holding se toca ni se borra, y cada fondo vuelve a
            vivir solo en el patrimonio.
          </p>
        </form>
      </section>
    </div>
  );
}

function FichaSkeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando cartera" className="section" role="status">
      <div className="skeletonTier" />
      <div className="skeletonTier skeletonShort" />
    </div>
  );
}
