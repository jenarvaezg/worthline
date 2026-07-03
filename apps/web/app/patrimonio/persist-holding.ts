import type { WorthlineStore } from "@worthline/db";
import { checkSinglePrimaryResidence, createManualAssetSafe } from "@worthline/domain";
import type { CreateManualAssetInput, Workspace } from "@worthline/domain";

import {
  createStableId,
  type HousingCreationData,
  mapDomainViolation,
} from "@web/intake";

/**
 * The persistence half of creating a manual asset, shared by the per-type add
 * route (`createAssetAction`) and the unified instrument-first add flow
 * (`createHoldingAction`). It runs the domain guard, writes the asset, and — for
 * a real-estate holding with acquisition data — seeds the acquisition anchor, the
 * appreciation rate, an optional initial valuation, and ripples historical
 * snapshots from the acquisition date (PRD #108). Pure of the clock: the caller
 * passes `seed` (stable-id source) and `today`.
 */
export type ManualAssetCreation = CreateManualAssetInput & HousingCreationData;

export async function persistManualAssetCreation(
  store: WorthlineStore,
  workspace: Workspace,
  command: ManualAssetCreation,
  seed: number,
  today: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const {
    acquisitionDate,
    acquisitionValueMinor,
    annualAppreciationRate,
    initialValuation,
    ...assetCommand
  } = command;

  const domainResult = createManualAssetSafe(workspace, assetCommand);

  if (!domainResult.ok) {
    return { ok: false, error: mapDomainViolation(domainResult.violations[0]) };
  }

  if (assetCommand.isPrimaryResidence) {
    const primaryViolation = checkSinglePrimaryResidence(
      await store.assets.readAssets(),
      { isPrimaryResidence: true },
    );

    if (primaryViolation) {
      return { ok: false, error: mapDomainViolation(primaryViolation) };
    }
  }

  if (assetCommand.type === "real_estate" && acquisitionDate && acquisitionValueMinor) {
    // ADR 0020: the whole real_estate creation sequence (asset + acquisition
    // anchor + rate + optional initial valuation) and its ripple ride ONE atomic
    // store seam. The anchor ids stay resolved here — `createStableId`/`seed` is a
    // determinism source, not clock/ripple arithmetic — and the from-date
    // (acquisition date) lives behind the seam.
    await store.createHousingHoldingAndRipple(
      {
        asset: assetCommand,
        acquisitionAnchor: {
          adjustsPriorCurve: true,
          assetId: assetCommand.id,
          id: createStableId("anchor", `${assetCommand.id}_acquisition`, seed),
          valuationDate: acquisitionDate,
          valueMinor: acquisitionValueMinor,
        },
        annualAppreciationRate: annualAppreciationRate ?? null,
        ...(initialValuation
          ? {
              initialValuation: {
                ...initialValuation,
                assetId: assetCommand.id,
                id: createStableId("anchor", `${assetCommand.id}_initial`, seed + 1),
              },
            }
          : {}),
      },
      { today },
    );
  } else {
    await store.assets.createManualAsset(assetCommand);
  }

  return { ok: true, id: assetCommand.id };
}
