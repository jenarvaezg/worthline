/**
 * Snapshot holding rows (ADR 0008).
 *
 * Every snapshot capture also records the valued portfolio behind its figures:
 * one row per holding, with the holding's stable id, its label and liquidity
 * tier copied (denormalized) at capture time, and its scope-weighted value in
 * integer minor units. Investments additionally carry units and unit price as
 * decimal strings.
 *
 * Per-tier aggregates are never stored — they are derived from these rows at
 * read time. At capture time the reconciliation invariant must hold: asset rows
 * sum exactly to the headline gross assets and liability rows to the headline
 * debts, or the capture fails loudly and persists nothing.
 */

import type { LiquidityTier } from "./classification";
import {
  housingAssetIdsOf,
  isLiquid,
  rungForLiability,
  securesHousingAsset,
  tierOfAsset,
} from "./classification";
import type { DecimalString } from "./decimal";
import { resolveScopeMemberIds } from "./scope";
import { allocateScopedHolding } from "./scope-allocation";
import type { Liability, ManualAsset, Workspace } from "./workspace-types";

export type SnapshotHoldingKind = "asset" | "liability";

/**
 * One frozen holding row behind a snapshot's figures. Label and tier are
 * denormalized on purpose: later renames, re-tierings, or deletions of the
 * holding must never alter what a past snapshot captured — no live foreign
 * keys into holdings.
 */
export interface SnapshotHoldingRow {
  /** The holding's stable id (asset or liability id) — informational, not a live FK. */
  holdingId: string;
  kind: SnapshotHoldingKind;
  /** The holding's name, frozen at capture time. */
  label: string;
  /**
   * The liquidity tier frozen at capture time. For liabilities, the tier is
   * resolved via the asset securing them — null when no asset secures the debt.
   */
  liquidityTier: LiquidityTier | null;
  /**
   * Whether this ASSET holding counted as a housing asset at capture time, frozen
   * from the live `isHousingAsset` classification (#181). Always false for
   * liabilities. Frozen on purpose: combined with `securesHousing` on the
   * liability side this makes the entire housing-equity axis row-derivable —
   * housingAssets = Σ(asset rows with countsAsHousing) and housingDebts =
   * Σ(liability rows with securesHousing), so no live lookup into current holding
   * identity is needed to reconstruct historical figures (ADR 0008).
   */
  countsAsHousing: boolean;
  /**
   * Whether this holding secures a housing asset, frozen at capture time from the
   * ALL-ASSETS classification (#180). Set only for liabilities — true when the
   * liability is associated to a housing asset present at capture, false
   * otherwise; always false for assets. Frozen on purpose: it makes the derived
   * housing-equity axis self-classifying, so historical figures never re-derive
   * the relationship from live holding identity (a live foreign key into frozen
   * history, which ADR 0008 forbids).
   */
  securesHousing: boolean;
  /** The scope-weighted value in integer minor units (same weighting as the headline figures). */
  valueMinor: number;
  /** Units held — investments only. */
  units?: DecimalString;
  /** Price per unit used that day — investments only, when a price was known. */
  unitPrice?: DecimalString;
  /**
   * The per-position breakdown frozen beneath a connected-source holding (ADR
   * 0035): one child row per coin/token. Present only for connected holdings that
   * carry positions; a manual holding (or a legacy capture) omits it entirely.
   * The rows sum EXACTLY to this holding's `valueMinor`, under the same scope
   * allocation and rounding — the reconciliation sub-sum (ADR 0008 extension).
   */
  positions?: SnapshotPositionRow[];
}

/**
 * One position's value and labelling, supplied to the capture for a
 * connected-source holding (ADR 0035). The `valueMinor` is the position's FULL
 * (pre-scope) value — the row-builder scope-allocates it down to the holding's
 * share. Values and labels only — never credentials, tokens or raw payloads.
 */
export interface SnapshotPositionInput {
  /** The source's STABLE per-line id (a coin's Numista `externalId`, ADR 0017) —
   *  NOT worthline's internal `id`, which is reassigned each sync. */
  positionKey: string;
  /** The position's display name, frozen at capture (a coin's title). */
  label: string;
  /** The position's FULL value in minor units, before scope allocation. */
  valueMinor: number;
  /** Grouping-lens metadata (a coin's metal); null when the source records none. */
  metal: string | null;
  /** The obverse thumbnail URL for the gallery image; null → metal-glyph fallback. */
  imageUrl: string | null;
}

/**
 * One frozen per-position child row beneath a connected-source holding row (ADR
 * 0035). Carries the stable position key, a frozen label, the SCOPE-WEIGHTED value
 * (its share of the holding's owned value), and the minimal display metadata the
 * second drilldown level renders. Values and labels only — no secrets.
 */
export interface SnapshotPositionRow {
  positionKey: string;
  label: string;
  /** The scope-weighted value in integer minor units; Σ over a holding's position
   *  rows equals the holding's `valueMinor` exactly (ADR 0035). */
  valueMinor: number;
  metal: string | null;
  imageUrl: string | null;
}

/** Units and unit price of one investment at capture time, keyed by asset id. */
export interface InvestmentCaptureDetail {
  units: DecimalString;
  unitPrice?: DecimalString;
}

export interface BuildSnapshotHoldingRowsInput {
  workspace: Workspace;
  scopeId: string;
  assets: ManualAsset[];
  liabilities?: Liability[];
  /** Per-investment units and unit price, keyed by asset id. */
  investmentDetails?: ReadonlyMap<string, InvestmentCaptureDetail>;
  /**
   * Per-connected-source position breakdown at capture time, keyed by the
   * materialized asset's id (ADR 0035) — the mirror of `investmentDetails`. An
   * asset present here freezes one position child row per entry beneath its
   * holding row, scope-allocated to sum exactly to the holding's value. Assets
   * absent here (manual holdings, investments) carry no position rows.
   */
  positionDetails?: ReadonlyMap<string, SnapshotPositionInput[]>;
}

/**
 * Distribute `totalMinor` across positions in proportion to their `weights` (each
 * position's full value) by the largest-remainder (Hamilton) method, so the parts
 * sum EXACTLY to `totalMinor` (ADR 0035 / ADR 0008). Flooring each proportional
 * share leaves a residual that is handed out one minor unit at a time to the
 * positions with the largest remainder, ties broken by original order. When the
 * weights sum to zero (every position valued 0) the total is zero too and every
 * share is 0. Inputs are non-negative (a coin collection's value and its coins').
 *
 * The `value × weight` product is computed in BigInt: for a large collection (a
 * six-figure-€ bullion holding) both factors are minor-unit magnitudes whose
 * product overflows `Number.MAX_SAFE_INTEGER`, which would silently corrupt the
 * floor and make the capture fail reconciliation. BigInt keeps it exact.
 */
function distributeByWeight(totalMinor: number, weights: readonly number[]): number[] {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight === 0) return weights.map(() => 0);

  const total = BigInt(totalMinor);
  const denominator = BigInt(totalWeight);
  // Exact integer floor + remainder of each proportional share.
  const parts = weights.map((weight, index) => {
    const scaled = total * BigInt(weight);
    return {
      floor: Number(scaled / denominator),
      index,
      remainder: scaled % denominator,
    };
  });

  let residual = totalMinor - parts.reduce((sum, part) => sum + part.floor, 0);

  // Order by descending remainder (ties by original index) and give each leftover
  // minor unit to the next in line.
  const byRemainder = [...parts].sort((left, right) => {
    if (left.remainder !== right.remainder)
      return left.remainder > right.remainder ? -1 : 1;
    return left.index - right.index;
  });

  const shares = parts.map((part) => part.floor);
  for (let i = 0; i < byRemainder.length && residual > 0; i += 1) {
    const index = byRemainder[i]!.index;
    shares[index] = shares[index]! + 1;
    residual -= 1;
  }
  return shares;
}

/**
 * Freeze a connected holding's position child rows (ADR 0035). Each input keeps
 * its key, label and display metadata; its value is the position's largest-
 * remainder share of the holding's already-scope-allocated `ownedMinor`, so the
 * rows sum EXACTLY to the holding's value under any ownership split.
 */
function buildPositionRows(
  details: readonly SnapshotPositionInput[],
  ownedMinor: number,
): SnapshotPositionRow[] {
  const shares = distributeByWeight(
    ownedMinor,
    details.map((detail) => detail.valueMinor),
  );
  return details.map((detail, index) => ({
    positionKey: detail.positionKey,
    label: detail.label,
    valueMinor: shares[index]!,
    metal: detail.metal,
    imageUrl: detail.imageUrl,
  }));
}

/**
 * Produce the holding rows behind a scope's snapshot.
 *
 * Values are scope-weighted with the exact same per-holding allocation
 * (allocateScopedHolding) the headline figures use, so the reconciliation
 * invariant holds by construction. Holdings with no ownership stake in the
 * scope are omitted — they are not behind the scope's figures.
 */
export function buildSnapshotHoldingRows(
  input: BuildSnapshotHoldingRowsInput,
): SnapshotHoldingRow[] {
  const scopeMemberIds = new Set(resolveScopeMemberIds(input.workspace, input.scopeId));
  const assetTierById = new Map(
    input.assets.map((asset) => [asset.id, tierOfAsset(asset)]),
  );
  // The ALL-ASSETS housing classification at capture time (#180) — the same basis
  // calculateNetWorth uses to net debts against housing. Frozen onto each row so
  // historical figures never re-derive it from live holding identity (ADR 0008).
  const housingAssetIds = housingAssetIdsOf(input.assets);
  const rows: SnapshotHoldingRow[] = [];

  for (const asset of input.assets) {
    const { ownedMinor, totalShareBps } = allocateScopedHolding(
      asset.currentValue.amountMinor,
      { ownership: asset.ownership, scopeMemberIds },
    );

    if (totalShareBps === 0) {
      continue;
    }

    const detail =
      asset.type === "investment" ? input.investmentDetails?.get(asset.id) : undefined;
    const positionDetail = input.positionDetails?.get(asset.id);
    const positions = positionDetail
      ? buildPositionRows(positionDetail, ownedMinor)
      : undefined;

    rows.push({
      countsAsHousing: housingAssetIds.has(asset.id),
      holdingId: asset.id,
      kind: "asset",
      label: asset.name,
      liquidityTier: tierOfAsset(asset),
      securesHousing: false,
      valueMinor: ownedMinor,
      ...(detail
        ? {
            units: detail.units,
            ...(detail.unitPrice !== undefined ? { unitPrice: detail.unitPrice } : {}),
          }
        : {}),
      ...(positions ? { positions } : {}),
    });
  }

  for (const liability of input.liabilities ?? []) {
    const { ownedMinor, totalShareBps } = allocateScopedHolding(
      liability.currentBalance.amountMinor,
      { ownership: liability.ownership, scopeMemberIds },
    );

    if (totalShareBps === 0) {
      continue;
    }

    rows.push({
      countsAsHousing: false,
      holdingId: liability.id,
      kind: "liability",
      label: liability.name,
      liquidityTier: liability.associatedAssetId
        ? rungForLiability(liability, assetTierById)
        : null,
      securesHousing: securesHousingAsset(liability, housingAssetIds),
      valueMinor: ownedMinor,
    });
  }

  return rows;
}

/**
 * The headline figures the holding rows must reconcile against. The first two
 * are the original ADR 0008 invariant (asset/liability row sums). The optional
 * three derived figures extend it (#181): when supplied, the reconcile also
 * proves the breakdown axes are self-consistent with the frozen rows, so a
 * ripple can never silently impute a value delta to the wrong axis.
 *
 * Note: `housingAssetsMinor` is no longer accepted here — it is derived from
 * the frozen `countsAsHousing` flags on asset rows (#181 completion). The
 * housing-equity check is now fully row-derived and requires no caller input.
 */
export interface SnapshotReconciliationTotals {
  grossAssetsMinor: number;
  debtsMinor: number;
  /** totalNetWorth, asserted to equal grossAssets − debts (#181). */
  totalNetWorthMinor?: number;
  /** liquidNetWorth, asserted to equal liquid asset rows − liquid non-housing debt rows (#181). */
  liquidNetWorthMinor?: number;
  /** housingEquity, asserted to equal countsAsHousing asset rows − securesHousing debt rows (#181). */
  housingEquityMinor?: number;
}

/**
 * The breakdown axes derived purely from the frozen holding rows (#181) — the
 * single place the ripple/capture summary is reconciled against. Mirrors
 * `calculateNetWorth`'s definitions exactly: liquid = top-two-rung asset rows
 * less liquid non-housing-securing debt rows; housing assets = asset rows with
 * frozen `countsAsHousing` true (#181); housing debts = the frozen
 * `securesHousing` debt rows. All five axes are now fully self-classifying from
 * the frozen flags — no caller-supplied housing-asset sum needed.
 */
export interface DerivedRowAxes {
  grossAssetsMinor: number;
  debtsMinor: number;
  /** Sum of asset rows on a liquid rung (cash + market). */
  liquidAssetsMinor: number;
  /** Sum of liability rows that are liquid AND do not secure housing. */
  liquidDebtsMinor: number;
  /** Sum of asset rows with frozen `countsAsHousing` true (#181). */
  housingAssetsMinor: number;
  /** Sum of liability rows with frozen `securesHousing` true. */
  housingDebtsMinor: number;
}

/**
 * Fold the frozen rows into the breakdown axes (#181). A liability's rung is its
 * own frozen tier when present, else `cash` — the same fallback `rungForLiability`
 * applies to an unassociated/non-housing debt, so a null-tier non-housing debt
 * (frozen with a null rung) lands on the liquid axis exactly as the live
 * `calculateNetWorth` path resolves it. The housing-asset sum is derived from
 * the frozen `countsAsHousing` flag on each asset row, making all five axes
 * self-classifying without any live `isHousingAsset` lookup (#181 completion).
 */
export function deriveRowAxes(rows: readonly SnapshotHoldingRow[]): DerivedRowAxes {
  let grossAssetsMinor = 0;
  let debtsMinor = 0;
  let liquidAssetsMinor = 0;
  let liquidDebtsMinor = 0;
  let housingAssetsMinor = 0;
  let housingDebtsMinor = 0;

  for (const row of rows) {
    if (row.kind === "asset") {
      grossAssetsMinor += row.valueMinor;
      if (row.liquidityTier !== null && isLiquid(row.liquidityTier)) {
        liquidAssetsMinor += row.valueMinor;
      }
      if (row.countsAsHousing) {
        housingAssetsMinor += row.valueMinor;
      }
    } else {
      debtsMinor += row.valueMinor;
      if (row.securesHousing) {
        housingDebtsMinor += row.valueMinor;
      } else if (isLiquid(row.liquidityTier ?? "cash")) {
        liquidDebtsMinor += row.valueMinor;
      }
    }
  }

  return {
    debtsMinor,
    grossAssetsMinor,
    housingAssetsMinor,
    housingDebtsMinor,
    liquidAssetsMinor,
    liquidDebtsMinor,
  };
}

/**
 * The reconciliation invariant (ADR 0008, extended in #181): asset rows must sum
 * EXACTLY to the headline gross assets and liability rows to the headline debts;
 * and — when the derived figures are supplied — the headline total / liquid /
 * housing figures must equal what the frozen rows derive (`deriveRowAxes` +
 * the caller's housing-asset sum). Throws a loud, descriptive error on any
 * mismatch so a capture never persists a portfolio that contradicts its own
 * figures, and a ripple can never impute a value delta to the wrong axis.
 */
export function assertSnapshotHoldingsReconcile(
  rows: readonly SnapshotHoldingRow[],
  totals: SnapshotReconciliationTotals,
): void {
  // The per-position sub-sum (ADR 0035): a holding that carries position rows must
  // have them sum EXACTLY to its own value, under the same scope allocation. A
  // holding with no position rows is unaffected — the original ADR 0008 invariant
  // alone applies to it.
  for (const row of rows) {
    if (row.positions === undefined) continue;
    const positionsSum = row.positions.reduce(
      (sum, position) => sum + position.valueMinor,
      0,
    );
    if (positionsSum !== row.valueMinor) {
      throw new Error(
        `Snapshot capture failed reconciliation: position rows of holding ` +
          `"${row.label}" (${row.holdingId}) sum to ${positionsSum} but the holding ` +
          `value is ${row.valueMinor} (minor units). Nothing was persisted.`,
      );
    }
  }

  const axes = deriveRowAxes(rows);

  if (axes.grossAssetsMinor !== totals.grossAssetsMinor) {
    throw new Error(
      `Snapshot capture failed reconciliation: asset rows sum to ${axes.grossAssetsMinor} ` +
        `but headline gross assets is ${totals.grossAssetsMinor} (minor units). ` +
        "Nothing was persisted.",
    );
  }

  if (axes.debtsMinor !== totals.debtsMinor) {
    throw new Error(
      `Snapshot capture failed reconciliation: liability rows sum to ${axes.debtsMinor} ` +
        `but headline debts is ${totals.debtsMinor} (minor units). ` +
        "Nothing was persisted.",
    );
  }

  if (totals.totalNetWorthMinor !== undefined) {
    const expected = totals.grossAssetsMinor - totals.debtsMinor;
    if (totals.totalNetWorthMinor !== expected) {
      throw new Error(
        `Snapshot capture failed reconciliation: total net worth is ` +
          `${totals.totalNetWorthMinor} but grossAssets − debts is ${expected} ` +
          "(minor units). Nothing was persisted.",
      );
    }
  }

  if (totals.liquidNetWorthMinor !== undefined) {
    const expected = axes.liquidAssetsMinor - axes.liquidDebtsMinor;
    if (totals.liquidNetWorthMinor !== expected) {
      throw new Error(
        `Snapshot capture failed reconciliation: liquid net worth is ` +
          `${totals.liquidNetWorthMinor} but liquid asset rows − liquid non-housing ` +
          `debt rows is ${expected} (minor units). Nothing was persisted.`,
      );
    }
  }

  if (totals.housingEquityMinor !== undefined) {
    // Housing assets are now row-derived from the frozen `countsAsHousing` flag
    // on each asset row (#181 completion) — no caller-supplied sum needed.
    const expected = axes.housingAssetsMinor - axes.housingDebtsMinor;
    if (totals.housingEquityMinor !== expected) {
      throw new Error(
        `Snapshot capture failed reconciliation: housing equity is ` +
          `${totals.housingEquityMinor} but countsAsHousing asset rows − securesHousing ` +
          `debt rows is ${expected} (minor units). Nothing was persisted.`,
      );
    }
  }
}

/**
 * One holding's contribution to the net-worth change between two consecutive
 * snapshots (#270). Label and tier are taken from the day the holding is present
 * (current preferred), mirroring how the frozen rows denormalize them.
 */
export interface HoldingDelta {
  holdingId: string;
  kind: SnapshotHoldingKind;
  label: string;
  liquidityTier: LiquidityTier | null;
  /**
   * Contribution to the NET-WORTH delta in minor units: an asset's value rise is
   * positive, a liability's balance rise is negative (paying a debt down lifts
   * net worth). Because the frozen rows reconcile to the headline figures each
   * day (ADR 0008), the contributions sum exactly to the day's net-worth change.
   */
  contributionMinor: number;
  /** `new` if absent the previous day, `gone` if absent the current day. */
  status: "new" | "gone" | "changed";
}

/**
 * Derive the per-holding contributions to the net-worth change from `previous`
 * to `current` — the two days' frozen holding rows (ADR 0008). Holdings whose
 * value did not move are omitted; the rest are sorted by contribution magnitude,
 * largest first. A holding present on only one day contributes its full value
 * (status `new`/`gone`).
 */
export function deriveHoldingDeltas(
  previous: readonly SnapshotHoldingRow[],
  current: readonly SnapshotHoldingRow[],
): HoldingDelta[] {
  const previousById = new Map(previous.map((r) => [r.holdingId, r]));
  const currentById = new Map(current.map((r) => [r.holdingId, r]));
  const ids = new Set([...previousById.keys(), ...currentById.keys()]);

  const deltas: HoldingDelta[] = [];
  for (const id of ids) {
    const cur = currentById.get(id);
    const prev = previousById.get(id);
    const ref = cur ?? prev;
    if (!ref) continue;

    const diff = (cur?.valueMinor ?? 0) - (prev?.valueMinor ?? 0);
    if (diff === 0) continue;

    deltas.push({
      holdingId: id,
      kind: ref.kind,
      label: ref.label,
      liquidityTier: ref.liquidityTier,
      contributionMinor: ref.kind === "asset" ? diff : -diff,
      status: !prev ? "new" : !cur ? "gone" : "changed",
    });
  }

  deltas.sort((a, b) => Math.abs(b.contributionMinor) - Math.abs(a.contributionMinor));
  return deltas;
}

/**
 * One coin/token's contribution to a connected holding's change between two
 * consecutive snapshots (ADR 0035) — the second drilldown level beneath a
 * `HoldingDelta`. Label and display metadata are taken from the day the position
 * is present (current preferred), mirroring how the frozen rows denormalize them.
 */
export interface PositionDelta {
  positionKey: string;
  label: string;
  metal: string | null;
  imageUrl: string | null;
  /**
   * Contribution to the holding's value change in minor units. Connected holdings
   * are assets, so a position's value rise is positive; a coin entering on its
   * acquisition date contributes its full value (a step-up), one leaving its full
   * negative value. The contributions sum to the holding's own change by
   * construction (the rows reconcile to the holding each day, ADR 0035).
   */
  contributionMinor: number;
  /** `new` if absent the previous day, `gone` if absent the current day. */
  status: "new" | "gone" | "changed";
}

/**
 * Derive the per-position contributions to a connected holding's change from
 * `previous` to `current` — the two days' frozen position rows (ADR 0035). The
 * mirror of `deriveHoldingDeltas` one level down: positions whose value did not
 * move are omitted; the rest are sorted by contribution magnitude, largest first.
 * Keyed by the stable `positionKey` (ADR 0017), so a coin keeps its identity across
 * a re-sync. Empty input yields no movers, so a holding with no frozen positions
 * shows no second drilldown level.
 */
export function derivePositionDeltas(
  previous: readonly SnapshotPositionRow[],
  current: readonly SnapshotPositionRow[],
): PositionDelta[] {
  const previousByKey = new Map(previous.map((row) => [row.positionKey, row]));
  const currentByKey = new Map(current.map((row) => [row.positionKey, row]));
  const keys = new Set([...previousByKey.keys(), ...currentByKey.keys()]);

  const deltas: PositionDelta[] = [];
  for (const key of keys) {
    const cur = currentByKey.get(key);
    const prev = previousByKey.get(key);
    const ref = cur ?? prev;
    if (!ref) continue;

    const diff = (cur?.valueMinor ?? 0) - (prev?.valueMinor ?? 0);
    if (diff === 0) continue;

    deltas.push({
      positionKey: key,
      label: ref.label,
      metal: ref.metal,
      imageUrl: ref.imageUrl,
      contributionMinor: diff,
      status: !prev ? "new" : !cur ? "gone" : "changed",
    });
  }

  deltas.sort((a, b) => Math.abs(b.contributionMinor) - Math.abs(a.contributionMinor));
  return deltas;
}
