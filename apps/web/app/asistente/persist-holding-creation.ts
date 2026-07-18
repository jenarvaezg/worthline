/**
 * Persist a holding-creation plan (#1105, PRD #1103 S2) through the SAME seams the
 * «Añadir holding» wizard uses — no new persistence. It dispatches by family:
 * stored/appreciating → the manual-asset seam, debt → the liability seam, investment
 * → the investment seam (+ an opening BUY dated today when declared). Kept reusable
 * so the S5 reconcile "create new" branch can call the exact same dispatch.
 *
 * Returns `{ ok, id }` or a Spanish `{ ok: false, error }` mapped from the domain
 * guards these seams already run — never throws on a domain violation.
 */

import {
  type ExposureCatalogStubCandidate,
  ensureExposureCatalogStubs,
} from "@web/ensure-exposure-catalog-stubs";
import { createStableId, mapDomainViolation } from "@web/intake";
import type { ManualAssetCreation } from "@web/patrimonio/persist-holding";
import { persistManualAssetCreation } from "@web/patrimonio/persist-holding";
import type { WorthlineStore } from "@web/store";
import type { HoldingCreationPlan } from "@worthline/db";
import type {
  CreateInvestmentOperationInput,
  CreateLiabilityInput,
} from "@worthline/domain";
import {
  checkOwnershipSplit,
  createInvestmentOperationSafe,
  createLiabilitySafe,
  defaultsFor,
} from "@worthline/domain";

export type PersistHoldingCreationResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export async function persistHoldingCreation(
  store: WorthlineStore,
  plan: HoldingCreationPlan,
  seed: number,
  today: string,
): Promise<PersistHoldingCreationResult> {
  const workspace = await store.workspace.readWorkspace();
  if (!workspace) return { error: "Workspace no inicializado.", ok: false };

  const defaults = defaultsFor(plan.instrument);

  if (plan.family === "stored") {
    const assetType = defaults.assetType;
    if (!assetType) return { error: "Instrumento no soportado para el alta.", ok: false };
    const id = createStableId("asset", plan.name, seed);
    const command: ManualAssetCreation = {
      currency: "EUR",
      currentValueMinor: plan.currentValueMinor,
      id,
      instrument: plan.instrument,
      liquidityTier: defaults.rung,
      name: plan.name,
      ownership: plan.ownership,
      type: assetType,
    };
    return persistManualAssetCreation(store, workspace, command, seed, today);
  }

  if (plan.family === "appreciating") {
    const id = createStableId("asset", plan.name, seed);
    // real_estate alta por estado actual: acquisition anchor dated today at the
    // declared current value (ADR 0056) — the housing seam ripples from today.
    const command: ManualAssetCreation = {
      acquisitionDate: today,
      acquisitionValueMinor: plan.currentValueMinor,
      currency: "EUR",
      currentValueMinor: plan.currentValueMinor,
      id,
      instrument: plan.instrument,
      isPrimaryResidence: plan.isPrimaryResidence,
      liquidityTier: defaults.rung,
      name: plan.name,
      ownership: plan.ownership,
      type: "real_estate",
    };
    return persistManualAssetCreation(store, workspace, command, seed, today);
  }

  if (plan.family === "debt") {
    const liabilitySpec = defaults.liability;
    if (!liabilitySpec) return { error: "Instrumento de deuda no soportado.", ok: false };
    const id = createStableId("debt", plan.name, seed);
    const command: CreateLiabilityInput = {
      balanceMinor: plan.balanceMinor,
      currency: "EUR",
      id,
      name: plan.name,
      ownership: plan.ownership,
      type: liabilitySpec.type,
    };
    const domainResult = createLiabilitySafe(workspace, command, {});
    if (!domainResult.ok) {
      return { error: mapDomainViolation(domainResult.violations[0]!), ok: false };
    }
    await store.liabilities.createLiability(command);
    await store.liabilities.setDebtModel(id, plan.debtModel);
    return { id, ok: true };
  }

  // investment
  const id = createStableId("asset", plan.name, seed);
  const splitViolation = checkOwnershipSplit(workspace, plan.ownership);
  if (splitViolation) {
    return { error: mapDomainViolation(splitViolation), ok: false };
  }
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id,
    instrument: plan.instrument,
    liquidityTier: defaults.rung,
    name: plan.name,
    ownership: plan.ownership,
    ...(plan.isin ? { isin: plan.isin } : {}),
    ...(defaults.priceProvider ? { priceProvider: defaults.priceProvider } : {}),
    ...(plan.providerSymbol ? { providerSymbol: plan.providerSymbol } : {}),
  });

  if (plan.opening) {
    // The opening BUY dated today, so the holding lands valued — same seam the
    // operations editor and the wizard's "saldo de hoy" path use.
    const op: CreateInvestmentOperationInput = {
      assetId: id,
      currency: "EUR",
      executedAt: today,
      id: createStableId("op", `${id}_opening`, seed),
      kind: "buy",
      pricePerUnit: plan.opening.pricePerUnit,
      source: "opening",
      units: plan.opening.units,
    };
    const safe = createInvestmentOperationSafe(op);
    if (!safe.ok) return { error: mapDomainViolation(safe.violations[0]!), ok: false };
    await store.command.recordInvestmentOperation(safe.value, { today });
  }

  // Register the (possibly empty) global-catalog row so the holding surfaces in
  // /admin/catalogo «por categorizar» (#1097). Best-effort: never blocks.
  const catalog: ExposureCatalogStubCandidate = {
    displayName: plan.name,
    instrument: plan.instrument,
    isin: plan.isin ?? null,
    priceProvider: defaults.priceProvider ?? null,
    providerSymbol: plan.providerSymbol ?? null,
  };
  await ensureExposureCatalogStubs([catalog]);

  return { id, ok: true };
}
