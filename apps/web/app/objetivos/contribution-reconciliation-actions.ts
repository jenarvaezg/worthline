"use server";

import { formAction } from "@web/form-action";
import {
  createStableId,
  errorRedirectUrl,
  parseMoneyMinor,
  successRedirectUrl,
} from "@web/intake";
import {
  expandPlannedContribution,
  normalizeDecimal,
  type PlannedContribution,
} from "@worthline/domain";

import { parseContributionPlanForm } from "./contribution-plan-form";

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

function destination(formData: FormData): string {
  return field(formData, "currentUrl") || "/objetivos";
}

function requireOccurrence(
  contribution: PlannedContribution,
  occurrenceId: string,
): void {
  const plannedDate = occurrenceId.slice(contribution.id.length + 1);
  if (
    !occurrenceId.startsWith(`${contribution.id}:`) ||
    expandPlannedContribution(contribution, plannedDate, plannedDate)[0]?.id !==
      occurrenceId
  ) {
    throw new Error("La ocurrencia ya no pertenece al plan actual.");
  }
}

export async function createPlannedContributionAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => destination(fd),
    run: async (store) => {
      await store.contributionPlan.createPlannedContribution({
        scopeId: field(formData, "scopeId"),
        ...parseContributionPlanForm(formData),
      });
      return { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(destination(formData), { message: error }),
    onSuccess: () => successRedirectUrl("/objetivos", "contribution_saved"),
  })(formData, ..._testArgs);
}

export async function updatePlannedContributionAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => destination(fd),
    run: async (store) => {
      await store.contributionPlan.updatePlannedContribution(
        field(formData, "contributionId"),
        parseContributionPlanForm(formData),
      );
      return { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(destination(formData), { message: error }),
    onSuccess: () => successRedirectUrl("/objetivos", "contribution_saved"),
  })(formData, ..._testArgs);
}

export async function deletePlannedContributionAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => destination(fd),
    run: async (store) => {
      await store.contributionPlan.deletePlannedContribution(
        field(formData, "contributionId"),
      );
      return { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(destination(formData), { message: error }),
    onSuccess: () => successRedirectUrl("/objetivos", "contribution_deleted"),
  })(formData, ..._testArgs);
}

export async function createAndLinkContributionOperationAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => destination(fd),
    run: async (store) => {
      const scopeId = field(formData, "scopeId");
      const contributionId = field(formData, "contributionId");
      const occurrenceId = field(formData, "occurrenceId");
      const executedAt = field(formData, "executedAt");
      const units = normalizeDecimal(field(formData, "units"));
      const pricePerUnit = normalizeDecimal(field(formData, "pricePerUnit"));
      const feesMinor = parseMoneyMinor(field(formData, "fees")) ?? 0;

      const contribution = (
        await store.contributionPlan.readContributionPlan(scopeId)
      ).contributions.find((item) => item.id === contributionId);
      if (!contribution) throw new Error("No se encontró la aportación planificada.");
      requireOccurrence(contribution, occurrenceId);
      const workspace = await store.workspace.readWorkspace();
      if (!workspace) throw new Error("Workspace no inicializado.");
      await store.command.createAndLinkContributionOperation({
        contributionId,
        occurrenceId,
        operation: {
          id: createStableId("op", occurrenceId, Date.now()),
          assetId: contribution.destinationHoldingId,
          kind: "buy",
          executedAt,
          units,
          pricePerUnit,
          currency: workspace.baseCurrency,
          feesMinor,
        },
      });
      return { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(destination(formData), { message: error }),
    onSuccess: () => successRedirectUrl("/objetivos", "contribution_linked"),
  })(formData, ..._testArgs);
}

export async function linkExistingContributionOperationAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => destination(fd),
    run: async (store) => {
      await store.contributionPlan.linkOperation({
        contributionId: field(formData, "contributionId"),
        occurrenceId: field(formData, "occurrenceId"),
        operationId: field(formData, "operationId"),
      });
      return { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(destination(formData), { message: error }),
    onSuccess: () => successRedirectUrl("/objetivos", "contribution_linked"),
  })(formData, ..._testArgs);
}

export async function closeContributionOccurrenceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => destination(fd),
    run: async (store) => {
      await store.contributionPlan.setOccurrenceState({
        contributionId: field(formData, "contributionId"),
        occurrenceId: field(formData, "occurrenceId"),
        state: "fulfilled",
      });
      return { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(destination(formData), { message: error }),
    onSuccess: () => successRedirectUrl("/objetivos", "contribution_fulfilled"),
  })(formData, ..._testArgs);
}

export async function skipContributionOccurrenceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => destination(fd),
    run: async (store) => {
      await store.contributionPlan.setOccurrenceState({
        contributionId: field(formData, "contributionId"),
        occurrenceId: field(formData, "occurrenceId"),
        state: "skipped",
      });
      return { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(destination(formData), { message: error }),
    onSuccess: () => successRedirectUrl("/objetivos", "contribution_skipped"),
  })(formData, ..._testArgs);
}

export async function applyStoredValueContributionAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => destination(fd),
    run: async (store) => {
      const newValueMinor = parseMoneyMinor(field(formData, "newValue"));
      const executedMinor = parseMoneyMinor(field(formData, "executedAmount"));
      if (newValueMinor === null || executedMinor === null) {
        throw new Error("El saldo y la aportación ejecutada deben ser importes válidos.");
      }
      await store.command.applyStoredContributionValue({
        contributionId: field(formData, "contributionId"),
        occurrenceId: field(formData, "occurrenceId"),
        assetId: field(formData, "assetId"),
        newValueMinor,
        executedMinor,
      });
      return { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(destination(formData), { message: error }),
    onSuccess: () => successRedirectUrl("/objetivos", "contribution_fulfilled"),
  })(formData, ..._testArgs);
}
