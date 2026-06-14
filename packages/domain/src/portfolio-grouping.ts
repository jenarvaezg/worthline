/**
 * Portfolio grouping (#154, PRD #146 S8) — presentation over the one holding model.
 *
 * The /patrimonio list is a single unified set of holdings (assets + liabilities).
 * Grouping is pure presentation: it re-buckets the projected rows by one of three
 * axes — direction (Activos/Pasivos, default), rung (the liquidity ladder), or
 * instrument (what each holding is) — WITHOUT splitting the model. A selected group
 * acts as the filter (the page renders that group). This is intentionally minimal;
 * the PRD says the surface is refined at UI time.
 */

import type { Instrument } from "./instrument-catalog";
import type { LiquidityTier } from "./liquidity-ladder";
import { LIQUIDITY_LADDER } from "./liquidity-ladder";
import type { MoneyMinor } from "./money";
import type {
  PortfolioProjection,
  ProjectedAssetRow,
  ProjectedLiabilityRow,
} from "./portfolio-projection";

// ── Grouping axes ──────────────────────────────────────────────────────────────

/** The three grouping axes, direction first (the default). */
export const PORTFOLIO_GROUP_KEYS = ["direction", "rung", "instrument"] as const;

/** A grouping axis for the unified holdings list. */
export type PortfolioGroupKey = (typeof PORTFOLIO_GROUP_KEYS)[number];

// ── Unified holding row ──────────────────────────────────────────────────────

/**
 * A single holding in the unified list, direction-tagged so the renderer knows
 * whether to show a value (asset) or a balance (liability) and which actions to
 * wire. An asset's value may be derived (ADR 0006) — `valueIsDerived` gates only
 * the display, never the row's edit/delete actions (#154).
 */
export type UnifiedHolding =
  | ({ direction: "asset" } & ProjectedAssetRow)
  | ({ direction: "liability" } & ProjectedLiabilityRow);

/** A labeled, ordered group of unified holdings, plus the group's signed total. */
export interface PortfolioGroup {
  /** Stable group key (e.g. "assets", "cash", "fund") — used in URLs and `aria`. */
  key: string;
  /** Human label (es-ES) for the group header. */
  label: string;
  holdings: UnifiedHolding[];
  /**
   * The group's total: assets sum positive, liabilities sum negative, so a
   * mixed group (rung/instrument) nets to the holdings' contribution to net worth.
   */
  totalMinor: MoneyMinor;
}

// ── Labels ───────────────────────────────────────────────────────────────────

const RUNG_LABELS: Record<LiquidityTier, string> = {
  cash: "Caja",
  illiquid: "Ilíquido",
  market: "Mercado",
  "term-locked": "A plazo",
};

/** Spanish instrument labels for the instrument grouping headers (#154). */
const INSTRUMENT_LABELS: Record<Instrument, string> = {
  current_account: "Cuenta corriente",
  term_deposit: "Depósito a plazo",
  fund: "Fondo",
  etf: "ETF",
  stock: "Acción",
  index: "Índice",
  pension_plan: "Plan de pensiones",
  crypto: "Cripto",
  precious_metal: "Metal precioso",
  vehicle: "Vehículo",
  property: "Inmueble",
  mortgage: "Hipoteca",
  loan: "Préstamo",
  credit_card: "Tarjeta de crédito",
  other: "Otro",
};

/** The es-ES label for an instrument — the instrument grouping header (#154). */
export function instrumentLabel(instrument: Instrument): string {
  return INSTRUMENT_LABELS[instrument];
}

// ── Grouping ─────────────────────────────────────────────────────────────────

/** Flatten a projection's two sections into one direction-tagged holding list. */
function unifyHoldings(projection: PortfolioProjection): UnifiedHolding[] {
  const [assets, liabilities] = projection.sections;
  return [
    ...assets.rows.map((row): UnifiedHolding => ({ direction: "asset", ...row })),
    ...liabilities.rows.map(
      (row): UnifiedHolding => ({ direction: "liability", ...row }),
    ),
  ];
}

/** A holding's signed contribution: assets add, liabilities subtract. */
function signedMinor(holding: UnifiedHolding): number {
  return holding.direction === "asset" ? holding.valueMinor : -holding.balanceMinor;
}

function makeGroup(
  key: string,
  label: string,
  holdings: UnifiedHolding[],
  currency: MoneyMinor["currency"],
): PortfolioGroup {
  const amountMinor = holdings.reduce((acc, h) => acc + signedMinor(h), 0);
  return { key, label, holdings, totalMinor: { amountMinor, currency } };
}

/**
 * Group a portfolio projection's unified holdings by one axis (#154). Empty groups
 * are omitted; the order is meaningful (direction: Activos→Pasivos; rung: ladder
 * order; instrument: first-seen). The reconciliation invariant of the projection is
 * untouched — this only re-buckets the same rows.
 */
export function groupPortfolio(
  projection: PortfolioProjection,
  groupBy: PortfolioGroupKey,
): PortfolioGroup[] {
  const holdings = unifyHoldings(projection);
  const currency = projection.totalGrossAssets.currency;

  if (groupBy === "direction") {
    const assets = holdings.filter((h) => h.direction === "asset");
    const liabilities = holdings.filter((h) => h.direction === "liability");
    const groups: PortfolioGroup[] = [];
    if (assets.length > 0) groups.push(makeGroup("assets", "Activos", assets, currency));
    if (liabilities.length > 0) {
      groups.push(makeGroup("liabilities", "Pasivos", liabilities, currency));
    }
    return groups;
  }

  if (groupBy === "rung") {
    return LIQUIDITY_LADDER.map((rung) => {
      const inRung = holdings.filter((h) => h.tier === rung);
      return inRung.length > 0
        ? makeGroup(rung, RUNG_LABELS[rung], inRung, currency)
        : null;
    }).filter((g): g is PortfolioGroup => g !== null);
  }

  // instrument — first-seen order keeps it stable without an arbitrary ranking.
  const order: Instrument[] = [];
  const byInstrument = new Map<Instrument, UnifiedHolding[]>();
  for (const holding of holdings) {
    const list = byInstrument.get(holding.instrument);
    if (list) {
      list.push(holding);
    } else {
      order.push(holding.instrument);
      byInstrument.set(holding.instrument, [holding]);
    }
  }
  return order.map((instrument) =>
    makeGroup(
      instrument,
      INSTRUMENT_LABELS[instrument],
      byInstrument.get(instrument)!,
      currency,
    ),
  );
}
