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
 * Collect the warnings to surface for a set of assets. Overrideable warnings with
 * a matching override are suppressed (the user marked them intentional); blocking
 * warnings are never suppressed.
 */
export function collectWarnings(
  assets: ManualAsset[],
  overrides: WarningOverride[] = [],
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
    if (
      valuationMethodOfAsset(a) === "derived" &&
      !a.providerSymbol &&
      !a.connectedSourceId
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
