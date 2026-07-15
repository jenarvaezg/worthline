/**
 * Build-time data for the hero sheet (#952, slice 4 of PRD #877).
 *
 * The public landing is a pure static route (#951): zero DB reads per visit.
 * This module is the ONE place allowed to touch `@worthline/db`, because it runs
 * exactly once — at build / prerender time, when its top-level `await` resolves —
 * never per request. It seeds the `familia` demo persona into a fresh ephemeral
 * **in-memory** libSQL database (no network, no file; ADR 0030), reads the
 * household scope's frozen history and latest monthly close through the same
 * engine the live dashboard uses, derives a plain serializable snapshot of the
 * figures, and then discards the store. The resolved `heroSheetData` object is
 * baked into the static HTML, so the sheet is real demo data reconciled by the
 * engine — not a mock, not a screenshot — while the runtime route stays static.
 *
 * It lives in this subdirectory (not a top-level `app/landing/*` file) so the
 * static-invariant tripwire (`landing-static.test.ts`, which scans only the
 * top level of `app/landing/` for `@worthline/db` and friends) never flags it:
 * `landing-content.tsx` only ever imports this module by relative path.
 */

import { seedDemoStore } from "@web/demo/store-provider";
import {
  deriveMonthlyCloses,
  formatMoneyMinor,
  LIQUIDITY_LADDER,
  type LiquidityTier,
  listScopeOptions,
  type MoneyMinor,
} from "@worthline/domain";

/** Pinned closed-ledger date: deterministic build, matches the "cerrado a 30 de junio" copy. */
const AS_OF = "2026-06-30";
const HOUSEHOLD_SCOPE = "household";
const SPARK_CLOSES = 12;

/** Sparkline geometry, matching the existing markup's viewBox. */
const SPARK_WIDTH = 297;
const SPARK_TOP = 8;
const SPARK_BOTTOM = 40;

const FULL_MONTHS_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

const SHORT_MONTHS_ES = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
];

/** One tier band of the composition bar. `housing` is the striped rung. */
export interface HeroSheetSegment {
  tier: LiquidityTier;
  label: string;
  /** CSS color for the band; `null` for the striped housing rung (styled by class). */
  tone: string | null;
  /** Integer percent of gross assets, for the legend copy. */
  pct: number;
  /** Precise CSS width (float percent) so the bands fill exactly. */
  width: string;
  housing: boolean;
  /** The tier's frozen holding value, minor units — lets CI reconcile against grossMinor independently of pct rounding. */
  amountMinor: number;
}

/** One ruled line of the sheet: a holding or the debt row. */
export interface HeroSheetRow {
  label: string;
  /** Already-formatted money string (engine figure, es-ES). */
  value: string;
  /** Optional small caption after the label (e.g. units). */
  meta?: string;
  /** The one debit row carries the debe line. */
  debit: boolean;
}

/** The plain, serializable snapshot baked into the static hero sheet. */
export interface HeroSheetData {
  asOf: string;
  currency: string;
  grossMinor: number;
  debtsMinor: number;
  netMinor: number;
  /** "291.604 €" */
  netLabel: string;
  /** Decorative full-precision watermark, e.g. "291.604,37". */
  netGhost: string;
  /** "+3.212 € este mes" (signed). */
  deltaLabel: string;
  /** The frozen close's liquid net worth, e.g. "96.410 €". */
  liquidLabel: string;
  /** "Folio 06 / 2026", derived from the latest frozen close. */
  folioLabel: string;
  /** "06/2026", the frozen close's month — for the MCP source line. */
  closeMonthLabel: string;
  /** "cerrado a 30 de junio", derived from the latest frozen close. */
  closedLabel: string;
  /** "jul 25 → jun 26". */
  sparkCaption: string;
  /** The last 12 monthly closes' total net worth, ascending, in minor units. */
  closes: number[];
  sparkline: { points: string; last: { x: number; y: number } };
  composition: HeroSheetSegment[];
  rows: HeroSheetRow[];
}

const LANDING_TIER_LABELS: Record<LiquidityTier, string> = {
  cash: "Efectivo",
  market: "Mercado",
  "term-locked": "Depósitos",
  illiquid: "Otros bienes",
  housing: "Vivienda",
};

const TIER_TONES: Record<LiquidityTier, string | null> = {
  cash: "var(--tier-cash)",
  market: "var(--tier-market)",
  "term-locked": "var(--tier-term-locked)",
  illiquid: "var(--tier-illiquid)",
  housing: null,
};

function shortMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-");
  return `${SHORT_MONTHS_ES[Number(month) - 1]} ${year!.slice(2)}`;
}

function money(amountMinor: number, currency: string): MoneyMinor {
  return { amountMinor, currency };
}

/** Sign-prefixed money label; formatMoneyMinor already renders a minus for negatives. */
function signedLabel(amountMinor: number, currency: string): string {
  const formatted = formatMoneyMinor(money(amountMinor, currency));
  return amountMinor > 0 ? `+${formatted}` : formatted;
}

function buildSparkline(closes: number[]): HeroSheetData["sparkline"] {
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min;
  const stepX = closes.length > 1 ? SPARK_WIDTH / (closes.length - 1) : 0;
  const height = SPARK_BOTTOM - SPARK_TOP;

  const coords = closes.map((value, index) => {
    const x = Math.round(index * stepX);
    // Higher net worth sits higher on the sheet (smaller y).
    const y =
      span === 0
        ? Math.round((SPARK_TOP + SPARK_BOTTOM) / 2)
        : Math.round(SPARK_BOTTOM - ((value - min) / span) * height);
    return { x, y };
  });

  return {
    points: coords.map(({ x, y }) => `${x},${y}`).join(" "),
    last: coords[coords.length - 1]!,
  };
}

async function buildHeroSheetData(): Promise<HeroSheetData> {
  const store = await seedDemoStore("familia", AS_OF);
  try {
    const workspace = await store.workspace.readWorkspace();
    if (!workspace) throw new Error("hero sheet: demo workspace failed to seed");

    const scopes = listScopeOptions(workspace);
    const household = scopes.find((scope) => scope.id === HOUSEHOLD_SCOPE);
    if (!household) throw new Error("hero sheet: household scope missing");

    const snapshots = await store.snapshots.readSnapshots(HOUSEHOLD_SCOPE);
    if (snapshots.length === 0) throw new Error("hero sheet: no snapshots seeded");

    const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));

    // The monthly close of each calendar month, ascending; keep the last 12.
    const closeIds = [...deriveMonthlyCloses(snapshots).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, id]) => id);
    const recentCloseIds = closeIds.slice(-SPARK_CLOSES);
    const recentCloses = recentCloseIds
      .map((id) => snapshotById.get(id))
      .filter(
        (snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== undefined,
      );

    const latest = recentCloses[recentCloses.length - 1]!;
    const previous = recentCloses[recentCloses.length - 2];
    const currency = latest.totalNetWorth.currency;

    const grossMinor = latest.grossAssets.amountMinor;
    const debtsMinor = latest.debts.amountMinor;
    const netMinor = latest.totalNetWorth.amountMinor;

    // Composition: bucket the frozen asset rows of the latest close by tier.
    const holdings = await store.snapshots.readSnapshotHoldings({
      scopeId: HOUSEHOLD_SCOPE,
      from: latest.dateKey,
      to: latest.dateKey,
    });
    const assetRows = holdings.filter((row) => row.kind === "asset");

    const byTier = new Map<LiquidityTier, number>();
    for (const row of assetRows) {
      const tier = row.liquidityTier ?? "cash";
      byTier.set(tier, (byTier.get(tier) ?? 0) + row.valueMinor);
    }

    const composition: HeroSheetSegment[] = LIQUIDITY_LADDER.filter(
      (tier) => (byTier.get(tier) ?? 0) > 0,
    ).map((tier) => {
      const sumMinor = byTier.get(tier) ?? 0;
      const share = grossMinor === 0 ? 0 : (sumMinor / grossMinor) * 100;
      const pct = Math.round(share);
      return {
        tier,
        label: `${LANDING_TIER_LABELS[tier]} ${pct} %`,
        tone: TIER_TONES[tier],
        pct,
        width: `${share.toFixed(2)}%`,
        housing: tier === "housing",
        amountMinor: sumMinor,
      };
    });

    // Sheet rows: top three asset holdings by value + the largest debt (the debe line).
    const topAssets = [...assetRows]
      .sort((a, b) => b.valueMinor - a.valueMinor)
      .slice(0, 3);
    const rows: HeroSheetRow[] = topAssets.map((row) => ({
      label: row.label,
      value: formatMoneyMinor(money(row.valueMinor, currency)),
      debit: false,
      ...(row.units ? { meta: `${row.units} part.` } : {}),
    }));

    const liabilityRows = holdings.filter((row) => row.kind === "liability");
    const largestDebt = liabilityRows.sort((a, b) => b.valueMinor - a.valueMinor)[0];
    if (largestDebt) {
      rows.push({
        label: largestDebt.label,
        value: formatMoneyMinor(money(-Math.abs(largestDebt.valueMinor), currency)),
        debit: true,
      });
    }

    const closes = recentCloses.map((snapshot) => snapshot.totalNetWorth.amountMinor);
    const deltaMinor = previous ? netMinor - previous.totalNetWorth.amountMinor : 0;

    // Copy tracks the latest FROZEN close, not the seed clock: the demo never
    // persists a snapshot for "today" (point-hoy is live, not frozen), so the
    // last close is the prior month-end — the honest anchor for a closed ledger.
    const [closeYear, closeMonth, closeDay] = latest.dateKey.split("-");
    const monthIndex = Number(closeMonth) - 1;

    return {
      asOf: AS_OF,
      currency,
      grossMinor,
      debtsMinor,
      netMinor,
      netLabel: formatMoneyMinor(money(netMinor, currency)),
      netGhost: (netMinor / 100).toLocaleString("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      deltaLabel: `${signedLabel(deltaMinor, currency)} este mes`,
      liquidLabel: formatMoneyMinor(latest.liquidNetWorth),
      folioLabel: `Folio ${closeMonth} / ${closeYear}`,
      closeMonthLabel: `${closeMonth}/${closeYear}`,
      closedLabel: `cerrado a ${Number(closeDay)} de ${FULL_MONTHS_ES[monthIndex]}`,
      sparkCaption: `${shortMonthLabel(recentCloses[0]!.monthKey)} → ${shortMonthLabel(latest.monthKey)}`,
      closes,
      sparkline: buildSparkline(closes),
      composition,
      rows,
    };
  } finally {
    store.close();
  }
}

/**
 * Resolved once at build time (top-level await) and baked into the static page.
 * The store is already torn down by the time this settles.
 */
export const heroSheetData: HeroSheetData = await buildHeroSheetData();
