import { compareUnits, type DecimalString } from "./decimal";
import { valuationMethodOfAsset } from "./holding-method";
import type { ManualAsset } from "./workspace-types";

export type WarningSeverity = "blocking" | "overrideable";

export interface DomainWarning {
  code: string;
  severity: WarningSeverity;
  entityType: "asset" | "liability";
  entityId: string;
  message: string;
}

/** A persisted acknowledgement that an overrideable warning is intentional. */
export interface WarningOverride {
  code: string;
  entityId: string;
}

/**
 * Dust threshold below which a derived holding's net units count as CLOSED
 * (#1348). The domain compares units to an exact "0" everywhere else, and a sell
 * of the whole recorded quantity does fold to exactly "0" — this threshold exists
 * for the imported case that does not: a broker statement whose closing sell is
 * rounded to fewer decimals than the buys it closes (`12.3456` against
 * `12.34567`) leaves sub-unit dust that is a closed position in every sense the
 * user cares about. Deliberately local to this rule rather than a `decimal.ts`
 * constant: the exact-zero comparisons elsewhere are about different questions.
 */
export const CLOSED_POSITION_UNITS_EPSILON: DecimalString = "0.0001";

export interface CollectWarningsOptions {
  /**
   * Net units still held per holding id (`derivePosition(...).currentUnits`), for
   * holdings that have at least one recorded operation. A `derived` holding whose
   * net units are ~0 is a CLOSED position kept as history: it contributes nothing
   * to today's figure, so its missing provider symbol harms nothing and
   * `MISSING_PROVIDER_SYMBOL` is not emitted (#1348). Reopen it with a new buy and
   * the warning returns.
   *
   * A holding ABSENT from the map is read as open — which covers both a caller
   * that read no ledger (behaviour unchanged) and a freshly created investment
   * with no operation yet, whose missing symbol is a real pending task rather
   * than a closed position.
   */
  netUnitsByAssetId?: ReadonlyMap<string, DecimalString>;
}

/**
 * Whether a holding is in scope for `MISSING_PROVIDER_SYMBOL` at all, before the
 * closed-position filter (#1348).
 */
function isProviderSymbolWarningCandidate(asset: ManualAsset): boolean {
  return (
    valuationMethodOfAsset(asset) === "derived" &&
    !asset.providerSymbol &&
    !asset.connectedSourceId
  );
}

/**
 * Collect the warnings to surface for a set of assets. Overrideable warnings with
 * a matching override are suppressed (the user marked them intentional); blocking
 * warnings are never suppressed.
 */
export function collectWarnings(
  assets: ManualAsset[],
  overrides: WarningOverride[] = [],
  options: CollectWarningsOptions = {},
): DomainWarning[] {
  const overridden = new Set(overrides.map((o) => `${o.code}:${o.entityId}`));
  const warnings: DomainWarning[] = [];

  for (const a of assets) {
    // A `derived` holding (investment) is valued only from its operations, so it
    // reads 0 before its first operation and after its position is fully sold —
    // both correct, not a misconfiguration — so it is never flagged (issue #157,
    // ADR 0006). `stored`/`appreciating` holdings genuinely left at 0 still warn.
    if (a.currentValue.amountMinor === 0 && valuationMethodOfAsset(a) !== "derived")
      warnings.push({
        code: "ZERO_VALUE_ASSET",
        severity: "overrideable",
        entityType: "asset",
        entityId: a.id,
        message: `"${a.name}" tiene valor 0.`,
      });

    // A `derived` holding (investment) with no provider symbol is an honest,
    // flagged state (ADR 0055): a pending task to set it later from Yahoo Finance
    // or similar, or to override for a hand-quoted fund. Applies to any
    // symbol-less investment, not only ones created by a statement import.
    // Exempt connected-source holdings (Binance, Numista, …, #685 bug): they
    // price via their source's own sync and will never carry a provider symbol.
    // Exempt CLOSED positions too (#1348): a fund sold in full is kept as
    // history and moves no figure, so the pending task no longer exists — the
    // warning would just regenerate daily and bury the actionable ones.
    if (
      isProviderSymbolWarningCandidate(a) &&
      !isClosedPosition(a, options.netUnitsByAssetId)
    )
      warnings.push({
        code: "MISSING_PROVIDER_SYMBOL",
        severity: "overrideable",
        entityType: "asset",
        entityId: a.id,
        message: `"${a.name}" no tiene símbolo de proveedor de precio. Indícalo o márcalo como intencional si cotiza a mano.`,
      });
  }

  return warnings.filter(
    (w) => w.severity === "blocking" || !overridden.has(`${w.code}:${w.entityId}`),
  );
}

/**
 * Whether a holding reads as a CLOSED position given the caller's net-units map
 * (#1348). This is the ONE definition of closed: the `MISSING_PROVIDER_SYMBOL`
 * filter above and the price-freshness filter in the data-quality engine both
 * call it, so neither can grow its own notion. Absent from the map = open.
 *
 * Takes the asset, not just its id, so the rule carries its own precondition:
 * only a `derived` holding HAS a position to close. A cash account or a flat is
 * valued from what the user typed, and no entry keyed to its id — however it got
 * there — may silence a signal about it.
 */
export function isClosedPosition(
  asset: ManualAsset,
  netUnitsByAssetId: ReadonlyMap<string, DecimalString> | undefined,
): boolean {
  if (valuationMethodOfAsset(asset) !== "derived") {
    return false;
  }

  const units = netUnitsByAssetId?.get(asset.id);
  return (
    units !== undefined &&
    compareUnits(units, CLOSED_POSITION_UNITS_EPSILON) < 0 &&
    compareUnits(units, `-${CLOSED_POSITION_UNITS_EPSILON}`) > 0
  );
}
