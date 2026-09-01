/**
 * «Tus objetivos»: the editable goals panel (PRD #507, S3).
 *
 * Its own module since #1700 — the page places panels, it does not define them.
 * Two forms per goal (save, delete) plus the create block; every figure it shows
 * comes pre-derived in the goal view (`fundedRatioBps`, `reservedMinor`,
 * `fireDelay`), so nothing here recomputes what the FIRE engine already said.
 */

import { ChipChoice } from "@web/chip-choice";
import type { FormErrorContext } from "@web/intake";
import { PendingSubmit } from "@web/pending-submit";
import type { ManualAsset, ObjetivosGoalView, ScopeOption } from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import { createGoalAction, deleteGoalAction, updateGoalAction } from "./goal-actions";

const PRIORITY_LEVELS = ["high", "medium", "low"] as const;

const PRIORITY_LABELS: Record<(typeof PRIORITY_LEVELS)[number], string> = {
  high: "Alta",
  low: "Baja",
  medium: "Media",
};

/** The priority radios, shared by the edit and the create form. */
function PriorityChoice({ selected }: { selected: string }) {
  return (
    <>
      <span className="memberProfileLabel">Prioridad</span>
      <span className="segmented">
        {PRIORITY_LEVELS.map((level) => (
          <label key={level}>
            <input
              defaultChecked={selected === level}
              name="priority"
              type="radio"
              value={level}
            />
            {PRIORITY_LABELS[level]}
          </label>
        ))}
      </span>
    </>
  );
}

export function GoalsSection({
  assets,
  currency,
  currentUrl,
  formError,
  goals,
  privacyMode,
  selectedScope,
}: {
  /** The holdings a goal may name as funding — the chip picker's options. */
  assets: ManualAsset[];
  currency: string;
  currentUrl: string;
  formError: FormErrorContext | null;
  goals: ObjetivosGoalView[];
  privacyMode: boolean;
  selectedScope: ScopeOption | undefined;
}) {
  return (
    <section className="firePanel" aria-label="Objetivos">
      <div className="panelHeader">
        <h3>Tus objetivos</h3>
        <span>
          {goals.length} {goals.length === 1 ? "objetivo" : "objetivos"}
        </span>
      </div>

      {selectedScope ? (
        <>
          {goals.length === 0 ? (
            <p className="muted">Aún no hay objetivos en este ámbito.</p>
          ) : null}

          <div className="goalList">
            {goals.map((view) => (
              <GoalRow
                assets={assets}
                currency={currency}
                currentUrl={currentUrl}
                formError={formError}
                key={view.goal.id}
                privacyMode={privacyMode}
                scopeId={selectedScope.id}
                view={view}
              />
            ))}
          </div>

          <div className="createBlock">
            <div className="memberProfileLabel">Nuevo objetivo</div>
            <GoalCreateForm
              assets={assets}
              currentUrl={currentUrl}
              formError={formError}
              scopeId={selectedScope.id}
            />
          </div>
        </>
      ) : (
        <p className="muted">Selecciona un scope para gestionar objetivos.</p>
      )}
    </section>
  );
}

function GoalRow({
  assets,
  currency,
  currentUrl,
  formError,
  privacyMode,
  scopeId,
  view,
}: {
  assets: ManualAsset[];
  currency: string;
  currentUrl: string;
  formError: FormErrorContext | null;
  privacyMode: boolean;
  scopeId: string;
  view: ObjetivosGoalView;
}) {
  const { goal, reservedMinor, fundedRatioBps, countsTowardFire, fireDelay } = view;
  const editValues = formError?.formId === `goal-${goal.id}` ? formError.values : {};
  const ev = (field: string, fallback: string) => editValues[field] ?? fallback;
  const editAssetIds = editValues.assetIds
    ? editValues.assetIds.split(",").filter(Boolean)
    : null;

  return (
    <div className="goalRow" id={`goalEdit-${goal.id}`}>
      <form action={updateGoalAction} className="stackForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={goal.id} />
        <input name="scopeId" type="hidden" value={scopeId} />
        {formError?.formId === `goal-${goal.id}` ? (
          <p className="formError" role="alert">
            {formError.message}
          </p>
        ) : null}
        <label>
          Nombre
          <input defaultValue={ev("name", goal.name)} name="name" />
        </label>
        <div className="goalFieldRow">
          <label>
            Importe objetivo (EUR)
            <input
              defaultValue={ev("targetAmount", (goal.targetAmountMinor / 100).toString())}
              inputMode="decimal"
              name="targetAmount"
            />
          </label>
          <label>
            Fecha límite
            <input
              defaultValue={ev("deadline", goal.deadline)}
              name="deadline"
              type="date"
            />
          </label>
        </div>
        <PriorityChoice selected={ev("priority", goal.priority)} />
        <span className="memberProfileLabel">
          Elige qué activos financian el objetivo
        </span>
        <ChipChoice
          name="assetIds"
          options={assets}
          selectedIds={editAssetIds ?? goal.assetIds}
        />
        <div className="goalFunded">
          <span className="memberProfileLabel">
            {(fundedRatioBps / 100).toFixed(0)} % financiado
          </span>
          <div className="fundedBar">
            <i
              className={fundedRatioBps >= 10_000 ? "full" : undefined}
              style={{ width: `${Math.min(100, fundedRatioBps / 100)}%` }}
            />
          </div>
          <span className="muted">
            Reservado{" "}
            {formatMoneyMinorPrivacy(
              { amountMinor: reservedMinor, currency },
              privacyMode,
            )}
          </span>
          {!countsTowardFire ? (
            <span className="objetivosGoalNote">no descuenta FIRE</span>
          ) : fireDelay.kind === "delays" ? (
            <span className="objetivosGoalNote fireDelay">
              {fireDelay.months === 0
                ? "Retrasa tu FIRE menos de 1 mes"
                : `Retrasa tu FIRE +${fireDelay.months} ${fireDelay.months === 1 ? "mes" : "meses"}`}
            </span>
          ) : (
            <span className="objetivosGoalNote">No afecta a tu FIRE</span>
          )}
        </div>
        <PendingSubmit pendingLabel="Guardando…">Guardar objetivo</PendingSubmit>
      </form>
      <form action={deleteGoalAction}>
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={goal.id} />
        <details suppressHydrationWarning className="confirmDelete">
          <summary>Eliminar</summary>
          <PendingSubmit pendingLabel="Borrando…">Confirmar borrado</PendingSubmit>
        </details>
      </form>
    </div>
  );
}

function GoalCreateForm({
  assets,
  currentUrl,
  formError,
  scopeId,
}: {
  assets: ManualAsset[];
  currentUrl: string;
  formError: FormErrorContext | null;
  scopeId: string;
}) {
  const cv = formError?.formId === "goal" ? formError.values : {};
  const createPriority = cv.priority ?? "medium";
  const createAssetIds = cv.assetIds ? cv.assetIds.split(",").filter(Boolean) : null;

  return (
    <form action={createGoalAction} className="stackForm" id="goalCreateForm">
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="scopeId" type="hidden" value={scopeId} />
      {formError?.formId === "goal" ? (
        <p className="formError" role="alert">
          {formError.message}
        </p>
      ) : null}
      <label>
        Nombre
        <input defaultValue={cv.name} name="name" placeholder="Entrada vivienda" />
      </label>
      <div className="goalFieldRow">
        <label>
          Importe objetivo (EUR)
          <input
            defaultValue={cv.targetAmount}
            inputMode="decimal"
            name="targetAmount"
            placeholder="60000"
          />
        </label>
        <label>
          Fecha límite
          <input defaultValue={cv.deadline} name="deadline" type="date" />
        </label>
      </div>
      <PriorityChoice selected={createPriority} />
      <span className="memberProfileLabel">Elige qué activos financian el objetivo</span>
      <ChipChoice name="assetIds" options={assets} selectedIds={createAssetIds ?? []} />
      <PendingSubmit className="createGoalSubmit" pendingLabel="Creando…">
        Crear objetivo
      </PendingSubmit>
    </form>
  );
}
