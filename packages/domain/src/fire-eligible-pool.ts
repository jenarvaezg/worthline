/**
 * The FIRE-eligible pool assembly (#1122): the risk-bearing loop that decides,
 * for a scope, what capital FIRE actually measures. Pulled out of
 * `calculateFireForScope` so its subtle rules — tier accumulation, primary-
 * residence and manual exclusion, netting secured debt against an *excluded*
 * asset, and clamping an underwater scope to zero — get a test surface of their
 * own instead of riding as untested orchestration in front of an over-tested
 * sheet.
 *
 * Pure and DB-free: it takes the already-loaded assets/liabilities/workspace and
 * returns the totals `calculateFireForScope` needs, with no reservation or rate
 * math (those stay in `fire.ts`).
 */

import { tierOfAsset } from "./classification";
import type { ContributionLot } from "./contribution-lots";
import { resolveHoldingLots } from "./contribution-lots";
import type { FireScopeConfig } from "./fire";
import type { DeclaredAvailability } from "./fire-capital-availability";
import type { RentRealReturns, RentReturnNotice } from "./fire-rent-return";
import type { AssetRateOverride } from "./fire-return";
import type { LiquidityTier } from "./liquidity-ladder";
import { rungForLiability } from "./liquidity-ladder";
import { resolveScopeMemberIds } from "./scope";
import { allocateScopedHolding } from "./scope-allocation";
import type { Liability, ManualAsset, Workspace } from "./workspace-types";

/**
 * Why an asset is held out of the FIRE-eligible total. `primary_residence`
 * comes from the asset's own flag; `manual` comes from `config.excludedAssetIds`.
 */
export type FireExclusionReason = "primary_residence" | "manual";

export interface FireExcludedAsset {
  id: string;
  name: string;
  reason: FireExclusionReason;
}

export interface AssembleFireEligiblePoolInput {
  /** Only the exclusion list matters here; the rest of the config drives later math. */
  config: Pick<FireScopeConfig, "excludedAssetIds">;
  assets: ManualAsset[];
  liabilities: Liability[];
  workspace: Workspace;
  scopeId: string;
  /**
   * Per-asset rates derived from declared net rent (#1448), plus the declarations
   * that could not produce one. Both are filtered here — the loop that already
   * decides eligibility and ownership is the only one entitled to say which
   * declaration actually took effect for this scope.
   */
  rentRealReturns?: RentRealReturns;
  /**
   * El día de lectura, cuando el llamador lo trae. Solo lo reclaman los lotes de
   * aportación (#1676): decidir qué tramo ya venció es la única pregunta de este
   * módulo que necesita un reloj. Sin él, un holding con lotes se declara entero como
   * hueco — que es lo único cierto que se puede decir sin saber qué día es.
   */
  todayISO?: string;
}

export interface FireEligiblePool {
  /**
   * Scope-owned eligible assets BEFORE debt is netted (minor units). Named
   * "pre-debt" — not "gross" — on purpose: `FireContext.eligibleGrossMinor` is
   * gross of goal *reservation* but already NET of debt, so reusing that word
   * here would invite wiring this pre-debt total straight into the context and
   * silently corrupting the FIRE number.
   */
  eligiblePreDebtMinor: number;
  /** Scoped debt netted against eligible capital; debt on an excluded asset is dropped. */
  scopedDebtMinor: number;
  /** Eligible net of scoped debt, clamped at 0 (an underwater scope reads as 0). */
  netEligibleMinor: number;
  /** Eligible minor per tier (gross), for the weighted real-return computation (N3, #515). */
  eligibleByTierMinor: Partial<Record<LiquidityTier, number>>;
  /**
   * The same scoped debt as `scopedDebtMinor`, attributed per rung (#1447): a
   * liability rides the rung of the asset it secures, and an unassociated one
   * (or one pointing at an asset that is gone) lands on `cash` — the ladder's
   * own rule (`rungForLiability`, ADR 0013/0022). Sums back to `scopedDebtMinor`.
   * It exists so `splitFireCapital` can net a mortgage inside the immobilized
   * side instead of against the market cash.
   */
  scopedDebtByTierMinor: Partial<Record<LiquidityTier, number>>;
  /**
   * Assets the scope holds that were left OUT of the eligible total, with the
   * reason. Scope-relative: an asset owned entirely outside the scope contributes
   * nothing and is not surfaced (listing it would just be noise).
   */
  excludedAssets: FireExcludedAsset[];
  /**
   * The per-asset rates that ACTUALLY apply to this scope's pool (#1448): eligible,
   * owned, and carrying a derived rate. `effectiveRealReturn` substitutes each one
   * over its slice of its tier. Empty when nothing was derived.
   */
  assetRateOverrides: AssetRateOverride[];
  /**
   * Declared rents that did not become a rate for an asset this scope actually
   * holds, with the reason (#1448). Scope-relative like `excludedAssets`, and
   * silent about assets FIRE excludes anyway: a warning about the primary
   * residence's rent would be noise, since its capital is out of FIRE too.
   */
  rentReturnNotices: RentReturnNotice[];
  /**
   * Las fechas de disponibilidad declaradas que ACTÚAN sobre este ámbito (#1528,
   * ADR 0100): elegibles, poseídas, y en el escalón `term-locked` — el único peldaño
   * que reclama un plazo (ADR 0013). El importe es lo que el ámbito posee, bruto de
   * deuda y de reserva, igual que `eligibleByTierMinor`.
   *
   * Se recogen AQUÍ y no en un segundo recorrido a propósito: el bucle que ya decide
   * elegibilidad y propiedad es el único con derecho a decir qué declaración tuvo
   * efecto para este ámbito — la misma razón por la que `assetRateOverrides` se filtra
   * aquí y no en el llamador.
   */
  declaredAvailability: DeclaredAvailability[];
  /**
   * Capital a plazo elegible y poseído que NO ha declarado fecha. No es cero y no es
   * bloqueo: es un hueco, y la pantalla lo nombra en vez de repartirlo como si
   * estuviera disponible hoy. Bruto de deuda y de reserva, como el de arriba.
   */
  undeclaredTermLockedMinor: number;
}

/**
 * Assemble the FIRE-eligible pool for one scope. See the module doc for the
 * rules it encodes; `calculateFireForScope` layers reservations and rate
 * resolution on top of what this returns.
 */
export function assembleFireEligiblePool(
  input: AssembleFireEligiblePoolInput,
): FireEligiblePool {
  const { config, assets, liabilities, workspace, scopeId } = input;
  const scopeMemberIds = new Set(resolveScopeMemberIds(workspace, scopeId));
  const excludedSet = new Set(config.excludedAssetIds ?? []);

  const rentRateByAssetId = input.rentRealReturns?.byAssetId;
  const rentNoticeByAssetId = new Map(
    (input.rentRealReturns?.notices ?? []).map((notice) => [notice.assetId, notice]),
  );

  let eligiblePreDebtMinor = 0;
  const assetRateOverrides: AssetRateOverride[] = [];
  const rentReturnNotices: RentReturnNotice[] = [];
  const excludedAssets: FireExcludedAsset[] = [];
  const excludedAssetIds = new Set<string>();
  const declaredAvailability: DeclaredAvailability[] = [];
  let undeclaredTermLockedMinor = 0;
  // Accumulate eligible minor units per tier for weighted return computation (N3, #515).
  const eligibleByTierMinor: Partial<Record<LiquidityTier, number>> = {};
  // The rung of every eligible asset, so a secured debt can inherit it below.
  const eligibleTierByAssetId = new Map<string, LiquidityTier>();

  for (const asset of assets) {
    const ownedMinor = allocateScopedHolding(asset.currentValue.amountMinor, {
      ownership: asset.ownership,
      scopeMemberIds,
    }).ownedMinor;

    const reason: FireExclusionReason | null = asset.isPrimaryResidence
      ? "primary_residence"
      : excludedSet.has(asset.id)
        ? "manual"
        : null;

    if (reason === null) {
      eligiblePreDebtMinor += ownedMinor;
      // Accumulate by tier for the weighted return calculation.
      const tier = tierOfAsset(asset);
      eligibleByTierMinor[tier] = (eligibleByTierMinor[tier] ?? 0) + ownedMinor;
      eligibleTierByAssetId.set(asset.id, tier);
      // La declaración de disponibilidad (#1528) se recoge en este mismo paso, y solo
      // en el escalón que la reclama: un holding que cambia de peldaño deja su fecha
      // inerte en vez de convertirla en un bloqueo que el peldaño no pide.
      if (ownedMinor > 0 && tier === "term-locked") {
        // Los lotes (#1676) se declaran sobre el holding ENTERO, igual que el valor
        // del que cuelgan, así que se reparten por la misma propiedad que acaba de
        // repartir ese valor. Sin lotes esto devuelve exactamente la fase 1.
        const resolved = resolveHoldingLots({
          availableFrom: asset.availableFrom,
          holdingMinor: ownedMinor,
          lots: scaleLotsToOwned(
            asset.contributionLots ?? [],
            ownedMinor,
            asset.currentValue.amountMinor,
          ),
          todayISO: input.todayISO,
        });
        declaredAvailability.push(...resolved.declared);
        undeclaredTermLockedMinor += resolved.undeclaredMinor;
      }
      // An asset the scope owns nothing of weighs nothing, so neither its derived
      // rate nor a warning about it belongs to this scope (#1448).
      if (ownedMinor > 0) {
        const derived = rentRateByAssetId?.get(asset.id);
        if (derived) {
          assetRateOverrides.push({
            amountMinor: ownedMinor,
            assetId: asset.id,
            rate: derived.rate,
            tier,
          });
        }
        const notice = rentNoticeByAssetId.get(asset.id);
        if (notice) {
          rentReturnNotices.push(notice);
        }
      }
      continue;
    }

    excludedAssetIds.add(asset.id);
    // Scope-relative: only surface what the scope actually holds. An excluded
    // asset owned entirely outside this scope contributes nothing either way,
    // so listing it would just be noise.
    if (ownedMinor > 0) {
      excludedAssets.push({ id: asset.id, name: asset.name, reason });
    }
  }

  // Net the scope's debt against eligible capital: coast/FIRE measures what you
  // could draw down, and a mortgage or loan is capital you don't own. A liability
  // secured against an EXCLUDED asset (primary residence / manual) is dropped with
  // that asset — netting it too would double-count the exclusion.
  let scopedDebtMinor = 0;
  const scopedDebtByTierMinor: Partial<Record<LiquidityTier, number>> = {};
  for (const liability of liabilities) {
    if (
      liability.associatedAssetId &&
      excludedAssetIds.has(liability.associatedAssetId)
    ) {
      continue;
    }
    const ownedMinor = allocateScopedHolding(liability.currentBalance.amountMinor, {
      ownership: liability.ownership,
      scopeMemberIds,
    }).ownedMinor;
    scopedDebtMinor += ownedMinor;
    // The rung comes from the ladder, never from a guess about the debt's type.
    const rung = rungForLiability(liability, eligibleTierByAssetId);
    scopedDebtByTierMinor[rung] = (scopedDebtByTierMinor[rung] ?? 0) + ownedMinor;
  }

  // ponytail: clamp at 0 — an underwater scope reads as 0 drawable capital, not
  // negative coast math. Tier weights stay gross (debt only shifts the level).
  const netEligibleMinor = Math.max(0, eligiblePreDebtMinor - scopedDebtMinor);

  return {
    declaredAvailability,
    undeclaredTermLockedMinor,
    eligiblePreDebtMinor,
    scopedDebtMinor,
    netEligibleMinor,
    eligibleByTierMinor,
    scopedDebtByTierMinor,
    excludedAssets,
    assetRateOverrides,
    rentReturnNotices,
  };
}

/**
 * Los lotes declarados sobre el holding entero, reducidos a lo que el ámbito posee.
 *
 * Por la MISMA fracción con la que ya se repartió el valor, y no por los bps de la
 * propiedad: un holding puede valer 0 y sus lotes no, y volver a preguntarle a la
 * propiedad abriría la puerta a que las dos cuentas discrepasen.
 *
 * Se escala sobre la suma ACUMULADA y no lote a lote, que es lo que garantiza que los
 * importes escalados sumen exactamente lo mismo que el acumulado escalado. Redondear
 * cada lote por su cuenta desvía céntimos, y aquí un céntimo no se pierde: reaparece
 * en la pantalla como «capital a plazo sin fecha» de 0,01 €, que es una frase falsa
 * sobre un descuadre de redondeo.
 *
 * Con el holding a cero no hay nada que repartir, y el llamador ya lo trata como tal.
 */
function scaleLotsToOwned(
  lots: readonly ContributionLot[],
  ownedMinor: number,
  totalMinor: number,
): ContributionLot[] {
  if (totalMinor <= 0) {
    return [];
  }

  const scaled: ContributionLot[] = [];
  let cumulativeMinor = 0;
  let cumulativeScaledMinor = 0;

  for (const lot of lots) {
    cumulativeMinor += lot.amountMinor;
    const nextScaledMinor = scaleToOwned(cumulativeMinor, ownedMinor, totalMinor);
    scaled.push({
      amountMinor: nextScaledMinor - cumulativeScaledMinor,
      availableFrom: lot.availableFrom,
    });
    cumulativeScaledMinor = nextScaledMinor;
  }

  return scaled;
}

function scaleToOwned(
  amountMinor: number,
  ownedMinor: number,
  totalMinor: number,
): number {
  if (totalMinor <= 0) {
    return 0;
  }
  return Math.round((amountMinor * ownedMinor) / totalMinor);
}
