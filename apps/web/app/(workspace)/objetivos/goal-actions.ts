"use server";

import { actionScopeExists, INVALID_SCOPE_MESSAGE } from "@web/action-scope";
import { currentUrlOf } from "@web/ajustes/connected-source-helpers";
import { formAction } from "@web/form-action";
import {
  appendParam,
  createStableId,
  errorRedirectUrl,
  parseEntityId,
  parseMoneyMinor,
  preserveFields,
} from "@web/intake";
import type { GoalPriority } from "@worthline/domain";

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

type ValidGoalForm = Extract<ParsedGoalForm, { ok: true }>;

export async function createGoalAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<ValidGoalForm>({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => currentUrlOf(fd),
    parse: ({ formData }) => {
      const parsed = parseGoalForm(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(currentUrlOf(formData), {
            message: parsed.error,
            formId: "goal",
            values: preserveGoalFields(formData),
            anchor: "goalCreateForm",
          }),
        };
      }
      return { ok: true, value: parsed };
    },
    run: async (store, { parsed }) => {
      if (!(await actionScopeExists(store, parsed.scopeId))) {
        return { ok: false, error: INVALID_SCOPE_MESSAGE };
      }
      await store.goals.createGoal({
        id: createStableId("goal", parsed.name, Date.now()),
        name: parsed.name,
        targetAmountMinor: parsed.targetAmountMinor,
        deadline: parsed.deadline,
        priority: parsed.priority,
        scopeId: parsed.scopeId,
        assetIds: parsed.assetIds,
      });
      return { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(currentUrlOf(formData), {
        message: error,
        formId: "goal",
        values: preserveGoalFields(formData),
        anchor: "goalCreateForm",
      }),
    onSuccess: ({ formData }) => appendParam(currentUrlOf(formData), "ok", "goal_saved"),
  })(formData, ..._testArgs);
}

export async function updateGoalAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<{ id: string; form: ValidGoalForm }>({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => currentUrlOf(fd),
    parse: ({ formData }) => {
      const id = parseEntityId(formData);
      if (!id) {
        return {
          ok: false,
          redirect: errorRedirectUrl(currentUrlOf(formData), {
            message: "Identificador de objetivo no encontrado.",
            formId: "goal",
            anchor: "goalCreateForm",
          }),
        };
      }
      const parsed = parseGoalForm(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(currentUrlOf(formData), {
            message: parsed.error,
            formId: `goal-${id}`,
            values: preserveGoalFields(formData),
            anchor: `goalEdit-${id}`,
          }),
        };
      }
      return { ok: true, value: { id, form: parsed } };
    },
    run: async (store, { parsed }) => {
      if (!(await actionScopeExists(store, parsed.form.scopeId))) {
        return { ok: false, error: INVALID_SCOPE_MESSAGE };
      }
      await store.goals.updateGoal({
        id: parsed.id,
        name: parsed.form.name,
        targetAmountMinor: parsed.form.targetAmountMinor,
        deadline: parsed.form.deadline,
        priority: parsed.form.priority,
        scopeId: parsed.form.scopeId,
        assetIds: parsed.form.assetIds,
      });
      return { ok: true };
    },
    onError: ({ formData, error }) => {
      const id = parseEntityId(formData);
      return errorRedirectUrl(currentUrlOf(formData), {
        message: error,
        formId: `goal-${id}`,
        values: preserveGoalFields(formData),
        anchor: `goalEdit-${id}`,
      });
    },
    onSuccess: ({ formData }) => appendParam(currentUrlOf(formData), "ok", "goal_saved"),
  })(formData, ..._testArgs);
}

export async function deleteGoalAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<string>({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => currentUrlOf(fd),
    parse: ({ formData }) => {
      const id = parseEntityId(formData);
      if (!id) {
        return {
          ok: false,
          redirect: errorRedirectUrl(currentUrlOf(formData), {
            message: "Identificador de objetivo no encontrado.",
            formId: "goal",
          }),
        };
      }
      return { ok: true, value: id };
    },
    run: async (store, { parsed }) => {
      await store.goals.deleteGoal(parsed);
      return { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(currentUrlOf(formData), { message: error, formId: "goal" }),
    onSuccess: ({ formData }) =>
      appendParam(currentUrlOf(formData), "ok", "goal_deleted"),
  })(formData, ..._testArgs);
}
