"use server";

import { type WorthlineStore } from "@worthline/db";
import type { GoalPriority } from "@worthline/domain";
import { redirect } from "next/navigation";

import {
  appendParam,
  createStableId,
  errorRedirectUrl,
  parseEntityId,
  parseMoneyMinor,
} from "@web/intake";
import { guardDemoWrite } from "@web/demo/write-guard";
import { runActionWithStore } from "@web/action-store";

import { currentUrlOf } from "@web/ajustes/connected-source-lifecycle";

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

export async function createGoalAction(formData: FormData, _store?: WorthlineStore) {
  await guardDemoWrite(currentUrlOf(formData));
  const parsed = parseGoalForm(formData);

  if (!parsed.ok) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), { message: parsed.error, formId: "goal" }),
    );
  }

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

export async function updateGoalAction(formData: FormData, _store?: WorthlineStore) {
  await guardDemoWrite(currentUrlOf(formData));
  const id = parseEntityId(formData);
  const parsed = parseGoalForm(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de objetivo no encontrado.",
        formId: "goal",
      }),
    );
  }
  if (!parsed.ok) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), { message: parsed.error, formId: "goal" }),
    );
  }

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

export async function deleteGoalAction(formData: FormData, _store?: WorthlineStore) {
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
