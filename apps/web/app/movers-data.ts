/**
 * Pure view-model for the home hero movers (#749).
 *
 * The dashboard route passes snapshots, holding rows, framing, currency, and
 * privacy state into `buildMoversDataByPeriod`; this module owns every mover
 * business rule (base selection, liquid filtering, debt sign, tags, ranking).
 */

import {
  formatMoneyMinorPrivacy,
  isLiquid,
  type LiquidityTier,
  type NetWorthFraming,
  type NetWorthSnapshot,
} from "@worthline/domain";

import { MOVERS_PERIOD_VIEW_PARAM, readViewParam } from "./view-state";

/** Mes (vs prior monthly close) · Año (YoY). */
export type MoversPeriod = "month" | "year";

export interface HoldingMover {
  label: string;
  /** "+1.234 €" / "−567 €" — € impact on net worth. */
  changeFmt: string;
  /** "+8,5 %" / "−2,6 %" or null when the holding is brand new (no base). */
  pctFmt: string | null;
  sign: "pos" | "neg" | "zero";
  /** "nuevo" (added since) / "vendido" (gone since), else null. */
  tag: "nuevo" | "vendido" | null;
  /** Liability holding — marks the row so the green-on-paydown sign reads clearly. */
  isDebt: boolean;
}

export interface MoversData {
  vsLabel: string;
  /** A comparison base exists for the selected period. */
  hasBase: boolean;
  /** Top gainers, € impact desc. */
  up: HoldingMover[];
  /** Top losers, € impact asc — most negative first. */
  down: HoldingMover[];
}

export type MoversDataByPeriod = Record<MoversPeriod, MoversData>;

const MOVERS_MAX_PER_COLUMN = 4;

export interface MoversHoldingRow {
  dateKey: string;
  holdingId: string;
  kind: "asset" | "liability";
  label: string;
  valueMinor: number;
  liquidityTier: LiquidityTier | null;
  securesHousing: boolean;
}

export function parseMoversPeriod(raw: string | string[] | undefined): MoversPeriod {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const search = v === undefined ? "" : `?mvp=${v}`;
  return readViewParam(search, MOVERS_PERIOD_VIEW_PARAM);
}

export function moversMonthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("es-ES", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y!, m! - 1, 1)));
}

export function moversBaseSnapshot(
  snapshots: NetWorthSnapshot[],
  period: MoversPeriod,
): NetWorthSnapshot | undefined {
  const latest = snapshots[snapshots.length - 1];
  if (!latest) return undefined;
  if (period === "year") {
    const [y, m] = latest.monthKey.split("-");
    const target = `${Number(y) - 1}-${m}`;
    const candidates = snapshots.filter((s) => s.monthKey <= target);
    return candidates[candidates.length - 1];
  }
  const candidates = snapshots.filter((s) => s.monthKey < latest.monthKey);
  return candidates[candidates.length - 1];
}

export function selectMoversHoldingRows(
  rows: MoversHoldingRow[],
  snapshots: NetWorthSnapshot[],
  period: MoversPeriod,
): MoversHoldingRow[] {
  const base = moversBaseSnapshot(snapshots, period);
  if (!base) return [];
  return rows.filter((row) => row.dateKey >= base.dateKey);
}

function moversIsLiquidHolding(meta: {
  kind: "asset" | "liability";
  tier: LiquidityTier | null;
  securesHousing: boolean;
}): boolean {
  if (meta.kind === "asset") return meta.tier !== null && isLiquid(meta.tier);
  if (meta.securesHousing) return false;
  return meta.tier === null || isLiquid(meta.tier);
}

function moversContribMinor(row: MoversHoldingRow): number {
  return row.kind === "liability" ? -row.valueMinor : row.valueMinor;
}

function moversPctFmt(pct: number): string {
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(1).replace(".", ",")} %`;
}

interface MoverRaw {
  label: string;
  impactMinor: number;
  pct: number | null;
  tag: "nuevo" | "vendido" | null;
  isDebt: boolean;
}

export function buildMoversData(params: {
  snapshots: NetWorthSnapshot[];
  selectedView: NetWorthFraming;
  period: MoversPeriod;
  holdingRows: MoversHoldingRow[];
  currency: string;
  privacyMode: boolean;
}): MoversData | null {
  const { snapshots, selectedView, period, holdingRows, currency, privacyMode } = params;
  const latest = snapshots[snapshots.length - 1];
  if (!latest) return null;

  const base = moversBaseSnapshot(snapshots, period);
  const vsLabel = base
    ? period === "year"
      ? `vs ${moversMonthLabel(base.monthKey)} (YoY)`
      : `vs cierre ${moversMonthLabel(base.monthKey)}`
    : period === "year"
      ? "Año anterior"
      : "Cierre anterior";
  if (!base) {
    return { vsLabel, hasBase: false, up: [], down: [] };
  }

  type Agg = {
    label: string;
    kind: "asset" | "liability";
    base: number;
    cur: number;
    tier: LiquidityTier | null;
    securesHousing: boolean;
    latestSeen: boolean;
  };
  const byHolding = new Map<string, Agg>();
  for (const row of holdingRows) {
    if (row.dateKey !== latest.dateKey && row.dateKey !== base.dateKey) continue;
    const key = `${row.kind}:${row.holdingId}`;
    const entry =
      byHolding.get(key) ??
      ({
        label: row.label,
        kind: row.kind,
        base: 0,
        cur: 0,
        tier: row.liquidityTier,
        securesHousing: row.securesHousing,
        latestSeen: false,
      } satisfies Agg);
    entry.label = row.label;
    const isLatest = row.dateKey === latest.dateKey;
    if (isLatest) entry.cur += moversContribMinor(row);
    else entry.base += moversContribMinor(row);
    if (isLatest || !entry.latestSeen) {
      entry.tier = row.liquidityTier;
      entry.securesHousing = row.securesHousing;
      if (isLatest) entry.latestSeen = true;
    }
    byHolding.set(key, entry);
  }

  const raw: MoverRaw[] = [];
  for (const e of byHolding.values()) {
    if (selectedView === "liquid" && !moversIsLiquidHolding(e)) continue;
    const impactMinor = e.cur - e.base;
    if (impactMinor === 0) continue;
    raw.push({
      label: e.label,
      impactMinor,
      isDebt: e.kind === "liability",
      pct: e.base !== 0 ? (impactMinor / Math.abs(e.base)) * 100 : null,
      tag: e.base === 0 ? "nuevo" : e.cur === 0 ? "vendido" : null,
    });
  }

  if (raw.length === 0) {
    return { vsLabel, hasBase: true, up: [], down: [] };
  }

  const toMover = (r: MoverRaw): HoldingMover => {
    const amount = formatMoneyMinorPrivacy(
      { amountMinor: r.impactMinor, currency },
      privacyMode,
    );
    return {
      label: r.label,
      changeFmt: `${r.impactMinor > 0 ? "+" : ""}${amount}`,
      isDebt: r.isDebt,
      pctFmt: r.pct === null ? null : moversPctFmt(r.pct),
      sign: r.impactMinor > 0 ? "pos" : r.impactMinor < 0 ? "neg" : "zero",
      tag: r.tag,
    };
  };

  const byImpactDesc = [...raw].sort((a, b) => b.impactMinor - a.impactMinor);

  return {
    vsLabel,
    hasBase: true,
    up: byImpactDesc
      .filter((r) => r.impactMinor > 0)
      .slice(0, MOVERS_MAX_PER_COLUMN)
      .map(toMover),
    down: byImpactDesc
      .filter((r) => r.impactMinor < 0)
      .reverse()
      .slice(0, MOVERS_MAX_PER_COLUMN)
      .map(toMover),
  };
}

export function buildMoversDataByPeriod(params: {
  snapshots: NetWorthSnapshot[];
  selectedView: NetWorthFraming;
  holdingRows: MoversHoldingRow[];
  currency: string;
  privacyMode: boolean;
}): MoversDataByPeriod | null {
  const monthRows = selectMoversHoldingRows(
    params.holdingRows,
    params.snapshots,
    "month",
  );
  const yearRows = selectMoversHoldingRows(params.holdingRows, params.snapshots, "year");
  const month = buildMoversData({ ...params, period: "month", holdingRows: monthRows });
  const year = buildMoversData({ ...params, period: "year", holdingRows: yearRows });
  if (!month || !year) return null;
  return { month, year };
}
