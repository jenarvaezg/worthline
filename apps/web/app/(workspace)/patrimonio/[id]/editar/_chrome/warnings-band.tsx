/**
 * The ficha's active warnings, and the «Es intencional» acknowledgement beside
 * each overrideable one.
 *
 * The collector reads the same closed-position filter as the board and the health
 * engine (#1348): once the position is sold out, the ficha stops asking for a
 * price symbol it no longer needs. The ledger comes from the family — a holding
 * that keeps none passes an empty one, which `netUnitsByAsset` leaves out of the
 * map, and absent means open.
 */

import { acknowledgeWarningAction } from "@web/patrimonio/actions";
import type { InvestmentOperation, ManualAsset } from "@worthline/domain";
import {
  collectWarnings,
  netUnitsByAsset,
  type WarningOverride,
} from "@worthline/domain";

export function WarningsBand({
  asset,
  currentUrl,
  id,
  operations,
  overrides,
}: {
  asset: ManualAsset | null;
  currentUrl: string;
  id: string;
  operations: InvestmentOperation[];
  overrides: WarningOverride[];
}) {
  const warnings = asset
    ? collectWarnings([asset], overrides, {
        netUnitsByAssetId: netUnitsByAsset(new Map([[id, operations]])),
        operationsByAssetId: new Map([[id, operations]]),
      })
    : [];

  if (warnings.length === 0) {
    return null;
  }

  return (
    <div className="warningBand" role="alert" aria-label="Avisos">
      {warnings.map((w) => (
        <div className="warningItem" key={`${w.entityId}-${w.code}`}>
          <span>⚠ {w.message}</span>
          {w.severity === "overrideable" ? (
            <form action={acknowledgeWarningAction}>
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input name="code" type="hidden" value={w.code} />
              <input name="entityId" type="hidden" value={id} />
              <button className="btnSmall btnWarning" type="submit">
                Es intencional
              </button>
            </form>
          ) : (
            <span className="blockingNote">No se puede ignorar</span>
          )}
        </div>
      ))}
    </div>
  );
}
