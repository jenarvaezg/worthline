import type { ManualAsset } from './index';

export type WarningSeverity = 'blocking' | 'overrideable';

export interface DomainWarning {
  code: string;
  severity: WarningSeverity;
  entityType: 'asset' | 'liability';
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
    if (a.currentValue.amountMinor === 0)
      warnings.push({
        code: 'ZERO_VALUE_ASSET',
        severity: 'overrideable',
        entityType: 'asset',
        entityId: a.id,
        message: `"${a.name}" tiene valor 0.`,
      });
  }

  return warnings.filter(
    (w) => w.severity === 'blocking' || !overridden.has(`${w.code}:${w.entityId}`),
  );
}
