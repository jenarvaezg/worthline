/**
 * The Zona de peligro — shared chrome, but with one read only the holding's shape
 * can justify (ADR 0085, #1549).
 *
 * The cash sibling of a live managed portfolio cannot be trashed on its own: it is
 * the container's casilla, created by the alta. This is the SAME read the store's
 * gate makes, so the ficha can never offer a delete the store would refuse. It is
 * asked only for a non-investment holding — the only shape a cash member can have
 * — so an investment ficha pays nothing for it.
 *
 * What the delete would WITHDRAW (#1365) and the traspaso exit it can offer are
 * not read here: they come from the family, which already derived the position and
 * the ledger. This panel never re-derives them.
 */

import type {
  FichaContext,
  ManualLedgerExit,
} from "@web/patrimonio/[id]/editar/_families/family-contract";
import { DangerZoneSection } from "@web/patrimonio/[id]/editar/_surfaces/danger-zone-section";
import type { HoldingTrashImpact, ManualAsset } from "@worthline/domain";
import type { ReactNode } from "react";

export async function loadDangerPanel(
  ficha: FichaContext,
  input: {
    /** The asset being edited, or null when the ficha is a liability's. */
    asset: ManualAsset | null;
    /** What the Papelera would withdraw, as the family derived it (#1365). */
    trashImpact: HoldingTrashImpact | null;
    /** The traspaso exit, offered only on a hand-written ledger (#1549). */
    manualLedger: ManualLedgerExit | null;
  },
): Promise<ReactNode> {
  const { currentUrl, formError, id, privacyMode, store, today } = ficha;
  const { asset, manualLedger, trashImpact } = input;

  if (!asset) {
    return (
      <DangerZoneSection
        currentUrl={currentUrl}
        holdingId={id}
        kind="liability"
        privacyMode={privacyMode}
      />
    );
  }

  const containerPortfolio =
    asset.type !== "investment"
      ? await store.managedPortfolios.readCashContainerName(id)
      : null;

  return (
    <DangerZoneSection
      containerPortfolio={containerPortfolio}
      currentUrl={currentUrl}
      formError={formError}
      holdingId={id}
      kind="asset"
      manualLedger={manualLedger}
      privacyMode={privacyMode}
      today={today}
      trashImpact={trashImpact}
    />
  );
}
