/**
 * The orphan investment: priced, valued, on screen — and unidentifiable (#1489).
 */

import { instrumentOfAsset } from "./classification";
import {
  type DataQualityCollector,
  type DataQualitySignal,
  signalLabelWithOverride,
  signalNaturalKey,
} from "./data-quality-collector";
import type { DecimalString } from "./decimal";
import { INVESTMENT_PROFILE_INSTRUMENTS } from "./exposure-identity";
import { valuationMethodOfAsset } from "./holding-method";
import { isClosedPosition } from "./warnings";
import type { ManualAsset } from "./workspace-types";

/**
 * Machine code for an investment priced by a provider symbol that carries NO ISIN
 * (#1489) — the orphan state, detectable in one query.
 *
 * The system's instrument identity is `isin ?? providerSymbol` (#539, ADR 0039), so a
 * symbol-only holding is not merely missing a label: a broker statement routing by
 * ISIN (ADR 0055) cannot land on it, the exposure catalog cannot hand it its profile,
 * and nothing in the product can decide that `IE00B52MJY50` and `SXR1.DE` are the same
 * ETF — which is how the assistant came to tell a real user his statement held a
 * DIFFERENT product from his own position.
 */
export const MISSING_INVESTMENT_ISIN_CODE = "MISSING_INVESTMENT_ISIN";

export interface DataQualityInstrumentIdentityInput {
  assets: readonly ManualAsset[];
  netUnitsByAssetId: ReadonlyMap<string, DecimalString>;
}

/**
 * `low` on purpose, and the exception that proves it: nothing on screen is wrong. The
 * price arrives through the provider symbol, so today's figure is as good as any
 * other holding's. What is missing only bites LATER — the next statement that will not
 * route, the exposure profile that will not be inherited, the assistant that cannot
 * tell the same product from a different one. A `medium` here would rank a latent gap
 * above a stale price that is wrong right now.
 *
 * Overrideable (ADR 0004): a product genuinely without an ISIN exists — the user marks
 * it intentional once and the signal stops nagging, without leaving the inventory.
 * Closed positions are silent for the reason they are silent everywhere else (#1348):
 * a sold-out position no longer receives statements.
 *
 * It files under `missing_configuration`, not a family of its own: what is absent is
 * a field on the ficha, and the surface that repairs it is the ficha.
 */
export const collectInstrumentIdentitySignals: DataQualityCollector<
  DataQualityInstrumentIdentityInput
> = (input) => {
  const signals: DataQualitySignal[] = [];

  for (const asset of input.assets) {
    if (
      !input.ownedAssetIds.has(asset.id) ||
      !isMissingIsinCandidate(asset) ||
      isClosedPosition(asset, input.netUnitsByAssetId)
    ) {
      continue;
    }

    const baseLabel =
      `"${asset.name}" no tiene ISIN: sin él un extracto no puede casar esta posición ` +
      "ni hereda su ficha de exposición. Añádelo en su ficha o márcalo como intencional.";
    signals.push({
      affected: { id: asset.id, label: asset.name, object: "holding" },
      category: "missing_configuration",
      code: MISSING_INVESTMENT_ISIN_CODE,
      fixable: true,
      label: signalLabelWithOverride(
        baseLabel,
        MISSING_INVESTMENT_ISIN_CODE,
        asset.id,
        input.overriddenKeys,
        true,
      ),
      naturalKey: signalNaturalKey(
        "missing_configuration",
        MISSING_INVESTMENT_ISIN_CODE,
        asset.id,
      ),
      severity: "low",
    });
  }

  return signals;
};

/**
 * Whether a holding is in scope for {@link MISSING_INVESTMENT_ISIN_CODE} at all.
 *
 * Four exclusions, each one a state where the missing ISIN is not a pending task:
 *  - a `stored`/`appreciating`/debt holding has no instrument identity to key;
 *  - a holding with NO provider symbol is already saying something worse, and
 *    `MISSING_PROVIDER_SYMBOL` says it — two signals over one hole would just teach
 *    the user to ignore both;
 *  - a connected-source rung is identified by its source (a Binance token has no
 *    ISIN and never will), exactly as it is exempt from the symbol warning (#685);
 *  - `crypto` (and anything else outside {@link INVESTMENT_PROFILE_INSTRUMENTS}) has
 *    no ISIN to be missing — the same set that decides who gets a look-through
 *    profile, read here so the two can never disagree about who HAS an identity.
 */
function isMissingIsinCandidate(asset: ManualAsset): boolean {
  return (
    valuationMethodOfAsset(asset) === "derived" &&
    // #1743: el hueco es el par entero. Un valor preservado con `kind` null cuenta
    // como identificador puesto, igual que contaba antes de tipar la columna; que
    // un `kind` null sea por sí mismo una señal lo decide #1745.
    !asset.securityId &&
    Boolean(asset.providerSymbol) &&
    !asset.connectedSourceId &&
    INVESTMENT_PROFILE_INSTRUMENTS.has(instrumentOfAsset(asset))
  );
}
