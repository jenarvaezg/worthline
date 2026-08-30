/**
 * Persist a holding-creation plan (#1105, PRD #1103 S2) through the SAME seams the
 * «Añadir holding» wizard uses — no new persistence. It dispatches by family:
 * stored/appreciating → the manual-asset seam, debt → the debt-alta seam (the
 * liability AND its model), investment → the investment-alta seam (the holding AND
 * its opening BUY dated today, when declared). Each of those is ONE unit of work
 * (#1599): a chat-confirmed alta that fails halfway leaves nothing behind, so the
 * proposal can be confirmed again. Kept reusable so the S5 reconcile "create new"
 * branch can call the exact same dispatch.
 *
 * Returns `{ ok, id }` or a Spanish `{ ok: false, error }` mapped from the domain
 * guards these seams already run — never throws on a domain violation.
 */

import { markFirstHoldingBestEffort } from "@web/activation-marks";
import {
  type ExposureCatalogStubCandidate,
  ensureExposureCatalogStubs,
} from "@web/ensure-exposure-catalog-stubs";
import { fetchFirstQuoteBestEffort } from "@web/first-quote";
import { createStableId, mapDomainViolation } from "@web/intake";
import type { ManualAssetCreation } from "@web/patrimonio/persist-holding";
import { persistManualAssetCreation } from "@web/patrimonio/persist-holding";
import type { WorthlineStore } from "@web/store";
import type { HoldingCreationPlan, InvestmentHoldingEntry } from "@worthline/db";
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
  nowIso: string,
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
    // A declared purchase anchors the curve WHERE IT HAPPENED (#1436): the
    // acquisition anchor carries the purchase price at its own date and today's
    // declared value lands as a market appraisal, so the property exists — for
    // every historical reconstruction — from the day it was bought. That is what
    // keeps a mortgage signed in 2004 from being reconstructed against a home the
    // app believes was born the day it was typed.
    //
    // Nothing declared → alta por estado actual: anchor dated today at the
    // declared current value (ADR 0056, the unmodelled past stays unmodelled).
    const acquisition = plan.acquisition;
    const command: ManualAssetCreation = {
      acquisitionDate: acquisition?.date ?? today,
      acquisitionValueMinor: acquisition?.valueMinor ?? plan.currentValueMinor,
      // Same-day purchase: the anchor already IS today's value — a second anchor
      // on the same date is what the wizard refuses too.
      ...(acquisition && acquisition.date !== today
        ? {
            initialValuation: {
              adjustsPriorCurve: true,
              valuationDate: today,
              valueMinor: plan.currentValueMinor,
            },
          }
        : {}),
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
    // ONE unit of work (#1599): the deuda and the model that decides how its
    // balance is valued land together, or neither does.
    await store.command.createDebtHolding({
      debtModel: plan.debtModel,
      liability: command,
      today,
    });
    return { id, ok: true };
  }

  // investment
  const id = createStableId("asset", plan.name, seed);
  const splitViolation = checkOwnershipSplit(workspace, plan.ownership);
  if (splitViolation) {
    return { error: mapDomainViolation(splitViolation), ok: false };
  }
  // The opening BUY dated today, so the holding lands valued — the commission rides
  // on the operation (#1315): the domain folds it into the cost basis (units × price
  // + fees), which is what keeps the return honest. Checked BEFORE anything is
  // written, so a refused opening is a message and not a 0 € fantasma (#1599).
  let entry: InvestmentHoldingEntry | undefined;
  if (plan.opening) {
    const op: CreateInvestmentOperationInput = {
      assetId: id,
      currency: "EUR",
      executedAt: today,
      id: createStableId("op", `${id}_opening`, seed),
      kind: "buy",
      pricePerUnit: plan.opening.pricePerUnit,
      source: "opening",
      units: plan.opening.units,
      ...(plan.opening.costBasisGrade === undefined
        ? {}
        : { costBasisGrade: plan.opening.costBasisGrade }),
      ...(plan.opening.feesMinor === undefined
        ? {}
        : { feesMinor: plan.opening.feesMinor }),
    };
    const safe = createInvestmentOperationSafe(op);
    if (!safe.ok) return { error: mapDomainViolation(safe.violations[0]!), ok: false };
    entry = { kind: "opening", operation: safe.value };
  }

  // ONE unit of work (#1599): the holding and its opening commit or roll back
  // together — the same seam the «Añadir holding» wizard writes through. Its
  // refusal is data, and this module promises a Spanish message rather than a
  // throw, so it is read and mapped like every other guard here.
  const created = await store.command.createInvestmentHolding({
    asset: {
      currency: "EUR",
      id,
      instrument: plan.instrument,
      liquidityTier: defaults.rung,
      name: plan.name,
      ownership: plan.ownership,
      ...(plan.isin ? { isin: plan.isin } : {}),
      ...(defaults.priceProvider ? { priceProvider: defaults.priceProvider } : {}),
      ...(plan.providerSymbol ? { providerSymbol: plan.providerSymbol } : {}),
    },
    today,
    ...(entry ? { entry } : {}),
  });

  if (!created.ok) {
    return { error: mapDomainViolation(created.violations[0]!), ok: false };
  }

  // An alta with a provider symbol lands with no cached quote, so it renders at
  // cost and its returns have nothing to work with. Ask for the first quote here
  // instead of waiting for the 21:00 capture (#1314) — deferred, never blocking.
  await fetchFirstQuoteBestEffort(
    {
      currency: "EUR",
      id,
      liquidityTier: defaults.rung,
      ...(defaults.priceProvider ? { priceProvider: defaults.priceProvider } : {}),
      ...(plan.providerSymbol ? { providerSymbol: plan.providerSymbol } : {}),
    },
    nowIso,
  );

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
  // A chat-driven alta (or the reconcile "create new" branch) can be the
  // workspace's first holding write — stamp the set-once mark (#1131).
  await markFirstHoldingBestEffort();

  return { id, ok: true };
}
