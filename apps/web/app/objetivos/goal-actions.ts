"use server";

import { actionScopeExists, INVALID_SCOPE_MESSAGE } from "@web/action-scope";
import { runActionWithStore, testStoreFromActionArgs } from "@web/action-store";
import { currentUrlOf } from "@web/ajustes/connected-source-helpers";
import { guardDemoWrite } from "@web/demo/write-guard";
import {
  appendParam,
  createStableId,
  errorRedirectUrl,
  parseEntityId,
  parseMoneyMinor,
  preserveFields,
} from "@web/intake";
import type { GoalPriority } from "@worthline/domain";
import { redirect } from "next/navigation";

type ParsedGoalForm =
  | {
      ok: true;
      name: string;
      scopeId: string;
      targetAmountMinor: number;
      deadline: string;
      priority: GoalPriority;
      assetIds: string[];
    }
  | { ok: false; error: string };

function parsePriority(raw: string): GoalPriority {
  return raw === "high" || raw === "low" ? raw : "medium";
}

/** Collect goal form fields for error-redirect preservation (including multi-value assetIds). */
function preserveGoalFields(formData: FormData): Record<string, string> {
  return {
    ...preserveFields(formData, ["name", "targetAmount", "deadline", "priority"]),
    assetIds: formData.getAll("assetIds").map(String).join(","),
  };
}

/** Parse and validate the goal form shared by create and update. */
function parseGoalForm(formData: FormData): ParsedGoalForm {
  const name = String(formData.get("name") ?? "").trim();
  const scopeId = String(formData.get("scopeId") ?? "").trim();
  const targetAmountMinor = parseMoneyMinor(String(formData.get("targetAmount") ?? ""));
  const deadline = String(formData.get("deadline") ?? "").trim();
  const priority = parsePriority(String(formData.get("priority") ?? ""));
  const assetIds = formData
    .getAll("assetIds")
    .map((value) => String(value))
    .filter(Boolean);

  if (!name) {
    return { ok: false, error: "El nombre del objetivo es obligatorio." };
  }
  if (!scopeId) {
    return { ok: false, error: "No se encontró el scope del objetivo." };
  }
  if (targetAmountMinor === null || targetAmountMinor <= 0) {
    return { ok: false, error: "El importe objetivo debe ser un número positivo." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    return { ok: false, error: "La fecha límite es obligatoria." };
  }

  return { ok: true, name, scopeId, targetAmountMinor, deadline, priority, assetIds };
}

async function redirectIfInvalidScope(
  formData: FormData,
  scopeId: string,
  formId: string,
  anchor: string,
  injectedStore?: ReturnType<typeof testStoreFromActionArgs>,
): Promise<void> {
  const exists = await runActionWithStore(
    (worthlineStore) => actionScopeExists(worthlineStore, scopeId),
    injectedStore,
  );

  if (!exists) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: INVALID_SCOPE_MESSAGE,
        formId,
        values: preserveGoalFields(formData),
        anchor,
      }),
    );
  }
}

export async function createGoalAction(formData: FormData, ..._testArgs: unknown[]) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData));
  const parsed = parseGoalForm(formData);

  if (!parsed.ok) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: parsed.error,
        formId: "goal",
        values: preserveGoalFields(formData),
        anchor: "goalCreateForm",
      }),
    );
  }

  await redirectIfInvalidScope(
    formData,
    parsed.scopeId,
    "goal",
    "goalCreateForm",
    _store,
  );

  await runActionWithStore(
    (store) =>
      store.goals.createGoal({
        id: createStableId("goal", parsed.name, Date.now()),
        name: parsed.name,
        targetAmountMinor: parsed.targetAmountMinor,
        deadline: parsed.deadline,
        priority: parsed.priority,
        scopeId: parsed.scopeId,
        assetIds: parsed.assetIds,
      }),
    _store,
  );
  redirect(appendParam(currentUrlOf(formData), "ok", "goal_saved"));
}

export async function updateGoalAction(formData: FormData, ..._testArgs: unknown[]) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData));
  const id = parseEntityId(formData);
  const parsed = parseGoalForm(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de objetivo no encontrado.",
        formId: "goal",
        anchor: "goalCreateForm",
      }),
    );
  }
  if (!parsed.ok) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: parsed.error,
        formId: `goal-${id}`,
        values: preserveGoalFields(formData),
        anchor: `goalEdit-${id}`,
      }),
    );
  }

  await redirectIfInvalidScope(
    formData,
    parsed.scopeId,
    `goal-${id}`,
    `goalEdit-${id}`,
    _store,
  );

  await runActionWithStore(
    (store) =>
      store.goals.updateGoal({
        id,
        name: parsed.name,
        targetAmountMinor: parsed.targetAmountMinor,
        deadline: parsed.deadline,
        priority: parsed.priority,
        scopeId: parsed.scopeId,
        assetIds: parsed.assetIds,
      }),
    _store,
  );
  redirect(appendParam(currentUrlOf(formData), "ok", "goal_saved"));
}

export async function deleteGoalAction(formData: FormData, ..._testArgs: unknown[]) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de objetivo no encontrado.",
        formId: "goal",
      }),
    );
  }

  await runActionWithStore((store) => store.goals.deleteGoal(id), _store);
  redirect(appendParam(currentUrlOf(formData), "ok", "goal_deleted"));
}
