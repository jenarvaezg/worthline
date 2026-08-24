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
  declareManagedPortfolioBalanceAction,
  deleteManagedPortfolioAction,
  setUndetailedRemainderAction,
  updateManagedPortfolioAction,
} from "@web/patrimonio/carteras/carteras-actions";
import {
  managedPortfolioMemberOptions,
  portfolioCompositionView,
  portfolioUndetailedView,
  portfolioWitnessView,
} from "@web/patrimonio/carteras/carteras-view";
import { loadCarteras } from "@web/patrimonio/carteras/load-carteras";
import { PendingSubmit } from "@web/pending-submit";
import {
  formatMoneyInput,
  formatMoneyMinorPrivacy,
  managedPortfolioMemberRoles,
} from "@worthline/domain";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

/**
 * Ficha de una cartera gestionada (ADR 0085, #1547) — addressed by its public
 * `wl_prt_…` id only (ADR 0069 discipline), like every holding ficha.
 *
 * Everything is derived on read: the total is the sum of its members + efectivo
 * (the same curve-valued figures the board prints), and the composition shows
 * each member's weight. The declared balance (#1550) is a WITNESS shown beside
 * the derived figures — never a value the book adopts — and the cash is shown
 * apart because the careo excludes it, exactly as the manager's app does. A
 * cartera registered without enumerating its composition (#1551) also carries a
 * "(sin detallar)" aggregate, with the block that walks its progressive
 * substitution. Nothing here claims a return yet (S6).
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

  const witness = portfolioWitnessView({
    baseCurrency: workspace.baseCurrency,
    moneyByHoldingId: model.moneyByHoldingId,
    portfolio,
    typeByHoldingId: model.typeByHoldingId,
  });

  // The "(sin detallar)" aggregate, when the cartera was registered without
  // enumerating its composition (#1551). Absent for a detailed one.
  const undetailed = portfolioUndetailedView({
    baseCurrency: workspace.baseCurrency,
    moneyByHoldingId: model.moneyByHoldingId,
    nameById: model.nameById,
    portfolio,
    publicIdByHolding: Object.fromEntries(
      holdingPublicIdIndex(publicIdRows).publicByInternal,
    ),
    typeByHoldingId: model.typeByHoldingId,
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

  // The chips' preselection is the INVESTMENT members and only them: the cash
  // sibling and the "(sin detallar)" aggregate are the container's own plumbing,
  // never offered and never removable from here (the store preserves both).
  const roles = managedPortfolioMemberRoles(portfolio.holdingIds, model.typeByHoldingId);
  // Only chips that RENDER can be preselected: a member whose holding died has
  // no chip to uncheck, so preselecting its id would make every save submit a
  // trashed holding and bounce forever. It leaves on the next save instead —
  // the note below says so.
  const selectableIds = new Set(options.map((option) => option.id));

  const errorFor = formError?.formId === `cartera-${portfolio.id}` ? formError : null;
  const witnessError = formError?.formId === `testigo-${portfolio.id}` ? formError : null;
  const undetailedError =
    formError?.formId === `agregado-${portfolio.id}` ? formError : null;
  const witnessValues = witnessError?.values ?? {};
  const undetailedValues = undetailedError?.values ?? {};
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
          valor derivado de sus miembros, careado contra el saldo que declares
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
        <p className="carterasHeroSplit">
          <span>
            Valor de mercado (tus fondos){" "}
            <span className="carterasHeroSplitFigure">
              {fmt(witness.investmentMinor)}
            </span>
          </span>
          <span>
            Efectivo de la cartera{" "}
            <span className="carterasHeroSplitFigure">{fmt(witness.cashMinor)}</span>
          </span>
        </p>
        <p className="muted">
          {composition.rows.length + composition.unknownMemberIds.length}{" "}
          {composition.rows.length + composition.unknownMemberIds.length === 1
            ? "miembro"
            : "miembros"}
          {" · "}la suma de sus holdings y su efectivo. Tu gestor enseña el efectivo
          aparte, y aquí también: el saldo que declaras se carea solo contra los fondos.
          Crear o editar la cartera nunca mueve tu patrimonio bruto: los miembros ya
          sumaban.
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
                    {row.isUndetailed ? " · sin detallar" : ""}
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
        aria-label="Saldo declarado"
        className="section"
        id={`portfolioWitness-${portfolio.id}`}
      >
        <div className="panelHeader">
          <h3>Saldo declarado</h3>
          <span>el careo con la app de tu gestor — sin la caja</span>
        </div>

        <table>
          <tbody>
            <tr>
              <th scope="row">Valor de mercado según worthline</th>
              <td className="carterasWeight">{fmt(witness.investmentMinor)}</td>
            </tr>
            <tr>
              <th scope="row">
                Saldo que declaraste
                {witness.declaredDateLabel ? ` · ${witness.declaredDateLabel}` : ""}
              </th>
              <td className="carterasWeight">
                {witness.declaredMinor === null ? "—" : fmt(witness.declaredMinor)}
              </td>
            </tr>
            <tr>
              <th scope="row">Deriva</th>
              <td className="carterasWeight">{witness.driftLabel ?? "—"}</td>
            </tr>
          </tbody>
        </table>

        {witness.isDiverged ? (
          <p className="warningBand" role="status">
            {witness.message}
          </p>
        ) : (
          <p className="muted">{witness.message}</p>
        )}

        <form action={declareManagedPortfolioBalanceAction} className="stackForm">
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="portfolioId" type="hidden" value={portfolio.id} />
          {witnessError ? (
            <p className="formError" role="alert">
              {witnessError.message}
            </p>
          ) : null}
          <label>
            Valor de mercado de la cartera, sin el efectivo ({workspace.baseCurrency})
            <input
              defaultValue={
                witnessValues.declaredValue ??
                (witness.declaredMinor === null
                  ? ""
                  : formatMoneyInput(witness.declaredMinor))
              }
              inputMode="decimal"
              name="declaredValue"
            />
          </label>
          <label>
            Fecha en la que lo leíste
            <input
              defaultValue={witnessValues.declaredDate ?? witness.declaredDate ?? today}
              max={today}
              name="declaredDate"
              type="date"
            />
          </label>
          <p className="muted">
            Teclea el número grande que ves en tu gestor: el valor de mercado de los
            fondos. El efectivo de la cartera ya lo lleva worthline en su propia fila, y
            no entra en este careo.
          </p>
          <PendingSubmit pendingLabel="Guardando…">Guardar saldo declarado</PendingSubmit>
        </form>

        {witness.declaredMinor === null ? null : (
          <form action={declareManagedPortfolioBalanceAction}>
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="portfolioId" type="hidden" value={portfolio.id} />
            <input name="clear" type="hidden" value="1" />
            <PendingSubmit pendingLabel="Borrando…">
              Borrar el saldo declarado
            </PendingSubmit>
          </form>
        )}
      </section>

      {undetailed ? (
        <section
          aria-label="Pendiente de detallar"
          className="section"
          id={`portfolioUndetailed-${portfolio.id}`}
        >
          <div className="panelHeader">
            <h3>Pendiente de detallar</h3>
            <span>la parte de la cartera que aún no has enumerado</span>
          </div>

          <table>
            <tbody>
              <tr>
                <th scope="row">
                  {undetailed.href ? (
                    <Link href={undetailed.href}>{undetailed.label}</Link>
                  ) : (
                    undetailed.label
                  )}
                </th>
                <td className="carterasWeight">{fmt(undetailed.valueMinor)}</td>
              </tr>
              <tr>
                <th scope="row">Fondos ya detallados</th>
                <td className="carterasWeight">{fmt(undetailed.detailedMinor)}</td>
              </tr>
              <tr>
                <th scope="row">Queda sin detallar (saldo declarado − detallado)</th>
                <td className="carterasWeight">
                  {undetailed.remainderMinor === null
                    ? "—"
                    : fmt(undetailed.remainderMinor)}
                </td>
              </tr>
            </tbody>
          </table>

          {undetailed.suggestsWithdrawal ? (
            <p className="warningBand" role="status">
              {undetailed.message}
            </p>
          ) : (
            <p className="muted">{undetailed.message}</p>
          )}

          {undetailed.suggestsWithdrawal ? null : (
            <form action={setUndetailedRemainderAction} className="stackForm">
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input name="portfolioId" type="hidden" value={portfolio.id} />
              {undetailedError ? (
                <p className="formError" role="alert">
                  {undetailedError.message}
                </p>
              ) : null}
              <label>
                Dejar el agregado en ({workspace.baseCurrency})
                <input
                  defaultValue={
                    undetailedValues.remainderValue ??
                    formatMoneyInput(undetailed.remainderMinor ?? undetailed.valueMinor)
                  }
                  inputMode="decimal"
                  name="remainderValue"
                />
              </label>
              <p className="muted">
                Un 0 retira el agregado: la cartera queda enteramente detallada. Ni el
                efectivo de la cartera ni el propio agregado entran en la resta — el saldo
                que declaras es el de los fondos.
              </p>
              <PendingSubmit pendingLabel="Guardando…">Guardar el agregado</PendingSubmit>
            </form>
          )}

          <form action={setUndetailedRemainderAction}>
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="portfolioId" type="hidden" value={portfolio.id} />
            <input name="withdraw" type="hidden" value="1" />
            {undetailed.suggestsWithdrawal && undetailedError ? (
              <p className="formError" role="alert">
                {undetailedError.message}
              </p>
            ) : null}
            <PendingSubmit pendingLabel="Retirando…">Retirar el agregado</PendingSubmit>
          </form>
        </section>
      ) : null}

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
              selectedIds={(preservedIds ?? roles.detailedHoldingIds).filter(
                (holdingId) => selectableIds.has(holdingId),
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
