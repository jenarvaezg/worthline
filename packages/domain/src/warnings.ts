import type { ManualAsset } from './index';

export type WarningSeverity = 'blocking' | 'overrideable';

export interface DomainWarning {
  code: string;
  severity: WarningSeverity;
  entityType: 'asset' | 'liability';
  entityId: string;
  message: string;
}

export function collectWarnings(assets: ManualAsset[]): DomainWarning[] {
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

  return warnings;
}
