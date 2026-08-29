/**
 * The `appreciating` housing ficha (PRD #108, #1441).
 *
 * Four reads, one wave (#446): the market appraisals that anchor the curve, the
 * appreciation rate that draws it between them, the cadence that decides its
 * shape (ADR 0031, #394; null reads as `step`), and the acquisition cost — the
 * property's OTHER number, never a point on its curve, and the only housing
 * write that ripples nothing.
 */

import { AcquisitionCostSection } from "@web/patrimonio/[id]/editar/_surfaces/acquisition-cost-section";
import { HousingValuationSection } from "@web/patrimonio/[id]/editar/_surfaces/housing-valuation-section";
import type { AssetFamilyContext, HoldingSurface } from "./family-contract";
import { holdingSurface } from "./family-contract";

export async function loadHousingSurface(
  ctx: AssetFamilyContext,
): Promise<HoldingSurface> {
  const { asset, currentUrl, formError, id, payoutsPanel, privacyMode, store, today } =
    ctx;

  const [anchors, appreciationRate, valuationCadence, acquisitionCostMinor] =
    await Promise.all([
      store.assets.readValuationAnchors(id),
      store.assets.readAnnualAppreciationRate(id),
      store.assets.readValuationCadence(id),
      store.assets.readAcquisitionCostMinor(id),
    ]);

  return holdingSurface("housing", {
    body: (
      <>
        {/* Cobros goes FIRST here, above the valuation sections: a rented flat's
            payouts are what the user comes to this ficha for, and the curve below
            is the slower conversation. */}
        {payoutsPanel}
        <HousingValuationSection
          anchors={anchors}
          appreciationRate={appreciationRate}
          assetId={asset.id}
          currentUrl={currentUrl}
          formError={formError}
          privacyMode={privacyMode}
          today={today}
          valuationCadence={valuationCadence}
        />
        <AcquisitionCostSection
          acquisitionCostMinor={acquisitionCostMinor}
          assetId={asset.id}
          currency={asset.currency}
          currentUrl={currentUrl}
          currentValueMinor={asset.currentValue.amountMinor}
          formError={formError}
          privacyMode={privacyMode}
        />
      </>
    ),
  });
}
