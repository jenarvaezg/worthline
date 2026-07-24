"use client";

import { PendingSubmit } from "@web/pending-submit";
import type {
  ContributionPlan,
  ContributionReconciliationProjection,
  InvestmentOperation,
  ManualAsset,
} from "@worthline/domain";
import { isValueUpdateEligible } from "@worthline/domain";
import { useEffect, useRef, useState } from "react";
import { contributionDrawerUrl } from "./contribution-drawer-state";
import {
  applyStoredValueContributionAction,
  closeContributionOccurrenceAction,
  createAndLinkContributionOperationAction,
  createPlannedContributionAction,
  deletePlannedContributionAction,
  linkExistingContributionOperationAction,
  skipContributionOccurrenceAction,
  updatePlannedContributionAction,
} from "./contribution-reconciliation-actions";

function amount(valueMinor: number, currency: string): string {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency,
  }).format(valueMinor / 100);
}

export function ContributionReconciliation({
  assets,
  currentUrl,
  plan,
  projection,
  selectedOccurrenceId,
  operations,
  currency,
  suggestedPriceByHoldingId,
}: {
  assets: ManualAsset[];
  currentUrl: string;
  plan: ContributionPlan;
  projection: ContributionReconciliationProjection;
  selectedOccurrenceId?: string;
  operations: InvestmentOperation[];
  currency: string;
  suggestedPriceByHoldingId: Record<string, string>;
}) {
  const [activeOccurrenceId, setActiveOccurrenceId] = useState(selectedOccurrenceId);
  const drawerRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const syncFromUrl = () => {
      setActiveOccurrenceId(
        new URL(window.location.href).searchParams.get("reconcile") ?? undefined,
      );
    };
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);
  useEffect(() => {
    if (activeOccurrenceId) drawerRef.current?.focus();
  }, [activeOccurrenceId]);
  useEffect(() => {
    if (!activeOccurrenceId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setActiveOccurrenceId(undefined);
      window.history.pushState({}, "", contributionDrawerUrl(window.location.href, null));
      queueMicrotask(() => triggerRef.current?.focus());
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [activeOccurrenceId]);
  const openDrawer = (occurrenceId: string, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setActiveOccurrenceId(occurrenceId);
    window.history.pushState(
      {},
      "",
      contributionDrawerUrl(window.location.href, occurrenceId),
    );
  };
  const closeDrawer = () => {
    setActiveOccurrenceId(undefined);
    window.history.pushState({}, "", contributionDrawerUrl(window.location.href, null));
    queueMicrotask(() => triggerRef.current?.focus());
  };
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const contributionById = new Map(plan.contributions.map((item) => [item.id, item]));
  const linked = new Set(
    [...projection.pending, ...projection.closed].flatMap((item) => item.operationIds),
  );
  const selected = projection.pending.find(
    (item) => item.occurrence.id === activeOccurrenceId,
  );
  const selectedContribution = selected
    ? contributionById.get(selected.occurrence.contributionId)
    : undefined;
  const selectedAsset = selected
    ? assetById.get(selected.occurrence.destinationHoldingId)
    : undefined;
  const existingBuys = selectedAsset
    ? operations.filter(
        (operation) =>
          operation.assetId === selectedAsset.id &&
          operation.kind === "buy" &&
          !linked.has(operation.id),
      )
    : [];

  return (
    <section className="firePanel contributionMap" aria-label="Plan de aportaciones">
      <div className="panelHeader">
        <h3>Mapa de capital</h3>
        <span>previsión → realidad, siempre de forma explícita</span>
      </div>

      <details className="contributionPlanEditor">
        <summary>Editar plan recurrente</summary>
        {plan.contributions.map((contribution) => (
          <div className="contributionPlanRule" key={contribution.id}>
            <form
              action={updatePlannedContributionAction}
              className="contributionPlanForm"
            >
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input name="contributionId" type="hidden" value={contribution.id} />
              <label>
                Destino
                <select
                  defaultValue={contribution.destinationHoldingId}
                  name="destinationHoldingId"
                >
                  {assets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Modo
                <select defaultValue={contribution.amount.mode} name="mode">
                  <option value="money">Dinero</option>
                  <option value="units">Unidades</option>
                </select>
              </label>
              <label>
                Importe / unidades
                <input
                  defaultValue={
                    contribution.amount.mode === "money"
                      ? contribution.amount.value / 100
                      : contribution.amount.value
                  }
                  inputMode="decimal"
                  name="amount"
                />
              </label>
              <label>
                Cadencia
                <select defaultValue={contribution.cadence.kind} name="cadence">
                  <option value="weekly">Semanal</option>
                  <option value="monthly">Mensual</option>
                  <option value="quarterly">Trimestral</option>
                  <option value="annual">Anual</option>
                </select>
              </label>
              <label>
                Día del mes
                <input
                  defaultValue={
                    contribution.cadence.kind === "monthly"
                      ? contribution.cadence.dayOfMonth
                      : 1
                  }
                  min="1"
                  max="31"
                  name="dayOfMonth"
                  type="number"
                />
              </label>
              <label>
                Día de semana (1–7)
                <input
                  defaultValue={
                    contribution.cadence.kind === "weekly"
                      ? contribution.cadence.weekday
                      : 1
                  }
                  min="1"
                  max="7"
                  name="weekday"
                  type="number"
                />
              </label>
              <label>
                Inicio
                <input
                  defaultValue={contribution.startDate}
                  name="startDate"
                  type="date"
                />
              </label>
              <label>
                Fin opcional
                <input defaultValue={contribution.endDate} name="endDate" type="date" />
              </label>
              <PendingSubmit pendingLabel="Guardando…">Guardar regla</PendingSubmit>
            </form>
            <form action={deletePlannedContributionAction}>
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input name="contributionId" type="hidden" value={contribution.id} />
              <PendingSubmit pendingLabel="Eliminando…">Eliminar regla</PendingSubmit>
            </form>
          </div>
        ))}
        <form action={createPlannedContributionAction} className="contributionPlanForm">
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="scopeId" type="hidden" value={plan.scopeId} />
          <label>
            Destino
            <select name="destinationHoldingId">
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Modo
            <select name="mode">
              <option value="money">Dinero</option>
              <option value="units">Unidades</option>
            </select>
          </label>
          <label>
            Importe / unidades
            <input inputMode="decimal" name="amount" required />
          </label>
          <label>
            Cadencia
            <select name="cadence">
              <option value="monthly">Mensual</option>
              <option value="weekly">Semanal</option>
              <option value="quarterly">Trimestral</option>
              <option value="annual">Anual</option>
            </select>
          </label>
          <label>
            Día del mes
            <input defaultValue="1" min="1" max="31" name="dayOfMonth" type="number" />
          </label>
          <label>
            Día de semana (1–7)
            <input defaultValue="1" min="1" max="7" name="weekday" type="number" />
          </label>
          <label>
            Inicio
            <input name="startDate" type="date" required />
          </label>
          <label>
            Fin opcional
            <input name="endDate" type="date" />
          </label>
          <PendingSubmit pendingLabel="Añadiendo…">Añadir aportación</PendingSubmit>
        </form>
      </details>
      <div className="contributionColumns">
        <div>
          <p className="memberProfileLabel">Por conciliar</p>
          {projection.pending.length === 0 ? (
            <p className="muted">No hay aportaciones pendientes en el horizonte.</p>
          ) : (
            <div className="contributionPendingList">
              {projection.pending.map((item) => {
                const asset = assetById.get(item.occurrence.destinationHoldingId);
                const planned =
                  item.summary.mode === "money"
                    ? amount(item.summary.plannedMinor, currency)
                    : `${item.summary.plannedUnits} uds.`;
                return (
                  <article className="contributionPendingRow" key={item.occurrence.id}>
                    <div>
                      <strong>{asset?.name ?? "Destino"}</strong>
                      <span>
                        {item.occurrence.plannedDate} ·{" "}
                        {item.backlog ? "atrasada" : "prevista"}
                      </span>
                    </div>
                    <div>
                      <strong>{planned}</strong>
                      <span>{item.state === "partial" ? "Parcial" : "Pendiente"}</span>
                    </div>
                    <button
                      onClick={(event) =>
                        openDrawer(item.occurrence.id, event.currentTarget)
                      }
                      type="button"
                    >
                      Registrar →
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </div>
        <aside>
          <p className="memberProfileLabel">Progreso cerrado</p>
          <strong>{projection.closed.length}</strong>
          <span>cumplidas u omitidas en el periodo</span>
        </aside>
      </div>

      {selected && selectedContribution && selectedAsset ? (
        <aside
          className="contributionDrawer"
          id="contributionDrawer"
          ref={drawerRef}
          tabIndex={-1}
        >
          <button
            aria-label="Cerrar conciliación"
            className="contributionDrawerClose"
            onClick={closeDrawer}
            type="button"
          >
            ×
          </button>
          <p className="memberProfileLabel">Registrar la realidad</p>
          <h3>{selectedAsset.name}</h3>
          <p className="muted">
            La previsión no se auto-concilia. Cada ejecución conserva su fecha, precio,
            unidades y comisiones reales.
          </p>
          <dl className="contributionProgress">
            <div>
              <dt>Previsto</dt>
              <dd>
                {selected.summary.mode === "money"
                  ? amount(selected.summary.plannedMinor, currency)
                  : `${selected.summary.plannedUnits} uds.`}
              </dd>
            </div>
            <div>
              <dt>Ejecutado</dt>
              <dd>
                {selected.summary.mode === "money"
                  ? amount(selected.summary.executedMinor, currency)
                  : `${selected.summary.executedUnits} uds. · ${amount(selected.summary.actualCashMinor, currency)}`}
              </dd>
            </div>
            <div>
              <dt>Delta</dt>
              <dd>
                {selected.summary.mode === "money"
                  ? amount(selected.summary.deltaMinor, currency)
                  : `${selected.summary.deltaUnits} uds.`}
              </dd>
            </div>
          </dl>

          {selectedAsset.type === "investment" ? (
            <>
              <form
                action={createAndLinkContributionOperationAction}
                className="stackForm"
              >
                <input name="currentUrl" type="hidden" value={currentUrl} />
                <input name="scopeId" type="hidden" value={plan.scopeId} />
                <input
                  name="contributionId"
                  type="hidden"
                  value={selectedContribution.id}
                />
                <input name="occurrenceId" type="hidden" value={selected.occurrence.id} />
                <label>
                  Fecha real
                  <input
                    defaultValue={selected.occurrence.plannedDate}
                    name="executedAt"
                    type="date"
                  />
                </label>
                <label>
                  Unidades compradas
                  <input
                    defaultValue={
                      selected.occurrence.amount.mode === "units"
                        ? selected.occurrence.amount.value
                        : ""
                    }
                    inputMode="decimal"
                    name="units"
                    required
                  />
                </label>
                <label>
                  Precio por unidad
                  <input
                    defaultValue={suggestedPriceByHoldingId[selectedAsset.id] ?? ""}
                    inputMode="decimal"
                    name="pricePerUnit"
                    required
                  />
                </label>
                <label>
                  Comisiones ({currency})
                  <input defaultValue="0" inputMode="decimal" name="fees" />
                </label>
                <PendingSubmit pendingLabel="Registrando…">
                  Añadir ejecución real
                </PendingSubmit>
              </form>
              {existingBuys.length > 0 ? (
                <div className="contributionExisting">
                  <p className="memberProfileLabel">Enlazar operación existente</p>
                  {existingBuys.map((operation) => (
                    <form
                      action={linkExistingContributionOperationAction}
                      key={operation.id}
                    >
                      <input name="currentUrl" type="hidden" value={currentUrl} />
                      <input
                        name="contributionId"
                        type="hidden"
                        value={selectedContribution.id}
                      />
                      <input
                        name="occurrenceId"
                        type="hidden"
                        value={selected.occurrence.id}
                      />
                      <input name="operationId" type="hidden" value={operation.id} />
                      <button type="submit">
                        {operation.executedAt.slice(0, 10)} · {operation.units} uds. ·
                        enlazar
                      </button>
                    </form>
                  ))}
                </div>
              ) : null}
            </>
          ) : isValueUpdateEligible(selectedAsset) ? (
            <form action={applyStoredValueContributionAction} className="stackForm">
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input name="assetId" type="hidden" value={selectedAsset.id} />
              <input
                name="contributionId"
                type="hidden"
                value={selectedContribution.id}
              />
              <input name="occurrenceId" type="hidden" value={selected.occurrence.id} />
              <label>
                Nuevo saldo ({currency})
                <input
                  defaultValue={(selectedAsset.currentValue.amountMinor / 100).toString()}
                  inputMode="decimal"
                  name="newValue"
                  required
                />
              </label>
              <label>
                Aportación ejecutada ({currency})
                <input
                  defaultValue={
                    selected.occurrence.amount.mode === "money"
                      ? (selected.occurrence.amount.value / 100).toString()
                      : ""
                  }
                  inputMode="decimal"
                  name="executedAmount"
                  required
                />
              </label>
              <PendingSubmit pendingLabel="Aplicando…">
                Aplicar actualización de saldo
              </PendingSubmit>
            </form>
          ) : (
            <p className="formError" role="alert">
              Este destino no admite conciliación directa: usa una inversión o un activo
              de valor almacenado.
            </p>
          )}

          {selected.operationIds.length > 0 ? (
            <form action={closeContributionOccurrenceAction}>
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input
                name="contributionId"
                type="hidden"
                value={selectedContribution.id}
              />
              <input name="occurrenceId" type="hidden" value={selected.occurrence.id} />
              <PendingSubmit pendingLabel="Cerrando…">Cerrar como cumplida</PendingSubmit>
            </form>
          ) : (
            <form action={skipContributionOccurrenceAction}>
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input
                name="contributionId"
                type="hidden"
                value={selectedContribution.id}
              />
              <input name="occurrenceId" type="hidden" value={selected.occurrence.id} />
              <PendingSubmit pendingLabel="Omitiendo…">
                Omitir esta ocurrencia
              </PendingSubmit>
            </form>
          )}
        </aside>
      ) : null}
      <p aria-live="polite" className="srOnly">
        {activeOccurrenceId ? "Conciliación abierta" : ""}
      </p>
    </section>
  );
}
