"use server";

import { runActionWithStore, testStoreFromActionArgs } from "@web/action-store";
import { guardDemoWrite } from "@web/demo/write-guard";
import { createStableId, parseMoneyMinor, successRedirectUrl } from "@web/intake";
import {
  expandPlannedContribution,
  normalizeDecimal,
  type PlannedContribution,
} from "@worthline/domain";
import { redirect } from "next/navigation";

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
  const injected = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(destination(formData));
  const parsed = parseContributionPlanForm(formData);
  await runActionWithStore(
    (store) =>
      store.contributionPlan.createPlannedContribution({
        scopeId: field(formData, "scopeId"),
        ...parsed,
      }),
    injected,
  );
  redirect(successRedirectUrl("/objetivos", "contribution_saved"));
}

export async function updatePlannedContributionAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const injected = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(destination(formData));
  await runActionWithStore(
    (store) =>
      store.contributionPlan.updatePlannedContribution(
        field(formData, "contributionId"),
        parseContributionPlanForm(formData),
      ),
    injected,
  );
  redirect(successRedirectUrl("/objetivos", "contribution_saved"));
}

export async function deletePlannedContributionAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const injected = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(destination(formData));
  await runActionWithStore(
    (store) =>
      store.contributionPlan.deletePlannedContribution(field(formData, "contributionId")),
    injected,
  );
  redirect(successRedirectUrl("/objetivos", "contribution_deleted"));
}

export async function createAndLinkContributionOperationAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const injected = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(destination(formData));
  const scopeId = field(formData, "scopeId");
  const contributionId = field(formData, "contributionId");
  const occurrenceId = field(formData, "occurrenceId");
  const executedAt = field(formData, "executedAt");
  const units = normalizeDecimal(field(formData, "units"));
  const pricePerUnit = normalizeDecimal(field(formData, "pricePerUnit"));
  const feesMinor = parseMoneyMinor(field(formData, "fees")) ?? 0;

  await runActionWithStore(async (store) => {
    const contribution = (
      await store.contributionPlan.readContributionPlan(scopeId)
    ).contributions.find((item) => item.id === contributionId);
    if (!contribution) throw new Error("No se encontró la aportación planificada.");
    requireOccurrence(contribution, occurrenceId);
    const workspace = await store.workspace.readWorkspace();
    if (!workspace) throw new Error("Workspace no inicializado.");
    await store.createAndLinkContributionOperation({
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
  }, injected);
  redirect(successRedirectUrl("/objetivos", "contribution_linked"));
}

export async function linkExistingContributionOperationAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const injected = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(destination(formData));
  await runActionWithStore(
    (store) =>
      store.contributionPlan.linkOperation({
        contributionId: field(formData, "contributionId"),
        occurrenceId: field(formData, "occurrenceId"),
        operationId: field(formData, "operationId"),
      }),
    injected,
  );
  redirect(successRedirectUrl("/objetivos", "contribution_linked"));
}

export async function closeContributionOccurrenceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const injected = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(destination(formData));
  await runActionWithStore(
    (store) =>
      store.contributionPlan.setOccurrenceState({
        contributionId: field(formData, "contributionId"),
        occurrenceId: field(formData, "occurrenceId"),
        state: "fulfilled",
      }),
    injected,
  );
  redirect(successRedirectUrl("/objetivos", "contribution_fulfilled"));
}

export async function skipContributionOccurrenceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const injected = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(destination(formData));
  await runActionWithStore(
    (store) =>
      store.contributionPlan.setOccurrenceState({
        contributionId: field(formData, "contributionId"),
        occurrenceId: field(formData, "occurrenceId"),
        state: "skipped",
      }),
    injected,
  );
  redirect(successRedirectUrl("/objetivos", "contribution_skipped"));
}

export async function applyStoredValueContributionAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const injected = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(destination(formData));
  const newValueMinor = parseMoneyMinor(field(formData, "newValue"));
  const executedMinor = parseMoneyMinor(field(formData, "executedAmount"));
  if (newValueMinor === null || executedMinor === null) {
    throw new Error("El saldo y la aportación ejecutada deben ser importes válidos.");
  }
  await runActionWithStore(
    (store) =>
      store.applyStoredContributionValue({
        contributionId: field(formData, "contributionId"),
        occurrenceId: field(formData, "occurrenceId"),
        assetId: field(formData, "assetId"),
        newValueMinor,
        executedMinor,
      }),
    injected,
  );
  redirect(successRedirectUrl("/objetivos", "contribution_fulfilled"));
}
