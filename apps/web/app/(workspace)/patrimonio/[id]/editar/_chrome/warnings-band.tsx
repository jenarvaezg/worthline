/**
 * The ficha's active warnings, and the «Es intencional» acknowledgement beside
 * each overrideable one.
 *
 * Which warnings are active is `holdingWarnings`, the one rule this band shares
 * with any family that prints a warning beside its figure instead (#1828): such a
 * family names the codes it placed, and the band leaves out exactly those. On a
 * tabbed ficha each warning also links to the tab and field where it is fixed.
 */

import type { FichaFix } from "@web/patrimonio/[id]/editar/_families/family-contract";
import { FichaTabLink } from "@web/patrimonio/[id]/editar/_ficha/ficha-tab-link";
import { acknowledgeWarningAction } from "@web/patrimonio/actions";
import type {
  InvestmentOperation,
  ManualAsset,
  WarningOverride,
} from "@worthline/domain";
import { holdingWarnings } from "./holding-warnings";

/** A fix the band links to, its URL already resolved against the ficha's tabs. */
export type ResolvedFichaFix = FichaFix & { href: string };

export function WarningsBand({
  asset,
  currentUrl,
  exclude = [],
  fixes = {},
  id,
  operations,
  overrides,
}: {
  asset: ManualAsset | null;
  currentUrl: string;
  /** The codes the ficha prints beside their figure, out of the band (#1828). */
  exclude?: readonly string[];
  /** By code: where the warning is fixed, for a ficha that has such a place. */
  fixes?: Readonly<Record<string, ResolvedFichaFix>>;
  id: string;
  operations: InvestmentOperation[];
  overrides: WarningOverride[];
}) {
  const warnings = holdingWarnings({ asset, id, operations, overrides }).filter(
    (warning) => !exclude.includes(warning.code),
  );

  if (warnings.length === 0) {
    return null;
  }

  return (
    <div className="warningBand" role="alert" aria-label="Avisos">
      {warnings.map((w) => {
        const fix = fixes[w.code];
        return (
          <div className="warningItem" key={`${w.entityId}-${w.code}`}>
            <span>⚠ {w.message}</span>
            {fix ? (
              <FichaTabLink
                className="btnSmall btnWarning"
                href={fix.href}
                tab={fix.tab}
                {...(fix.field ? { field: fix.field } : {})}
              >
                {fix.label}
              </FichaTabLink>
            ) : null}
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
        );
      })}
    </div>
  );
}
