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
import { LIQUIDITY_LADDER, LIQUIDITY_TIER_LABELS } from "./liquidity-ladder";
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

/**
 * A managed portfolio as the grouping needs it (#1548): who it is and which
 * holdings belong to it. The domain never reads the store — the caller passes
 * this in, exactly like the projection.
 */
export interface ManagedPortfolioGrouping {
  id: string;
  name: string;
  provider: string | null;
  /** Member holding ids. Membership is exclusive, so no id repeats across two. */
  holdingIds: readonly string[];
}

/**
 * One summand of the list: a loose holding, or a managed portfolio as a block.
 *
 * The `kind` discriminant is what keeps the board honest — a renderer that
 * forgets the portfolio branch fails to compile rather than silently dropping
 * eight positions.
 */
export type BoardUnit =
  | {
      kind: "holding";
      /** Stable render key — the holding id. */
      key: string;
      holding: UnifiedHolding;
      /** Signed contribution: assets add, liabilities subtract. */
      signedMinor: number;
    }
  | {
      kind: "portfolio";
      /** Stable render key — the portfolio id. */
      key: string;
      portfolio: ManagedPortfolioGrouping;
      /** Present members, largest first (ties by id, so the order is stable). */
      members: UnifiedHolding[];
      /** The block's value: the sum of its members. Always an asset figure. */
      signedMinor: number;
      /** The rung the block is filed under: its members' dominant one by value. */
      tier: UnifiedHolding["tier"];
      /** The instrument the block is filed under: its dominant one by value. */
      instrument: Instrument;
    };

/** A labeled, ordered group of unified holdings, plus the group's signed total. */
export interface PortfolioGroup {
  /** Stable group key (e.g. "assets", "cash", "fund") — used in URLs and `aria`. */
  key: string;
  /** Human label (es-ES) for the group header. */
  label: string;
  /**
   * Every holding in the group, portfolio members included — the flattened
   * view of {@link units}, kept so anything that only needs rows (totals,
   * reconciliation, the older callers) reads one list and cannot drift from
   * the summands: it is derived FROM `units`, never assembled apart.
   */
  holdings: UnifiedHolding[];
  /**
   * The group's summands (#1548): loose holdings and whole managed portfolios.
   * This is what the board renders; `holdings` is the flattening of it.
   */
  units: BoardUnit[];
  /**
   * The group's total: assets sum positive, liabilities sum negative, so a
   * mixed group (rung/instrument) nets to the holdings' contribution to net worth.
   */
  totalMinor: MoneyMinor;
}

// ── Labels ───────────────────────────────────────────────────────────────────

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
  coin_collection: "Colección de monedas",
  other: "Otro",
};

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

/**
 * A holding's signed contribution: assets add, liabilities subtract. Public
 * because the board's optimistic merge re-sums a portfolio block after a member
 * leaves, and two places applying the sign rule is one place too many.
 */
export function signedMinor(holding: UnifiedHolding): number {
  return holding.direction === "asset" ? holding.valueMinor : -holding.balanceMinor;
}

function makeGroup(
  key: string,
  label: string,
  units: BoardUnit[],
  currency: MoneyMinor["currency"],
): PortfolioGroup {
  const amountMinor = units.reduce((acc, u) => acc + u.signedMinor, 0);
  return {
    holdings: units.flatMap((u) => (u.kind === "holding" ? [u.holding] : u.members)),
    key,
    label,
    totalMinor: { amountMinor, currency },
    units,
  };
}

/**
 * The dominant key by value — the rung or instrument a portfolio is filed
 * under. Ties break by the key's own order so the same portfolio never lands in
 * two different buckets between renders.
 */
function dominant<K extends string>(weightByKey: Map<K, number>, fallback: K): K {
  const ranked = [...weightByKey.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return ranked[0]?.[0] ?? fallback;
}

/**
 * Fold the projection's rows into summands: one per loose holding, one per
 * managed portfolio that has members present.
 *
 * "Present" is the operative word. A portfolio's member list is workspace-wide,
 * while the projection is one scope's live rows, so a member can legitimately
 * be absent (other scope, trashed, sold out of the list). The block is then
 * built from whoever IS here, and a portfolio with nobody present produces no
 * summand at all — never an empty header quoting 0 €.
 *
 * A member that is somehow a liability stays a loose row: a debt inside an
 * investment container cannot happen today (the store only admits live manual
 * investments), and folding one into an asset block would flip its sign.
 */
function buildUnits(
  holdings: UnifiedHolding[],
  managedPortfolios: readonly ManagedPortfolioGrouping[],
): BoardUnit[] {
  const portfolioByHolding = new Map<string, ManagedPortfolioGrouping>();
  for (const portfolio of managedPortfolios) {
    for (const holdingId of portfolio.holdingIds) {
      portfolioByHolding.set(holdingId, portfolio);
    }
  }

  // First pass: who is a member of what, and in what order the summands appear.
  // A block takes the place of its FIRST member in the row order, so grouping
  // never teleports a portfolio to the end of the list.
  const order: (UnifiedHolding | ManagedPortfolioGrouping)[] = [];
  const membersByPortfolio = new Map<string, UnifiedHolding[]>();
  for (const holding of holdings) {
    const portfolio =
      holding.direction === "asset" ? portfolioByHolding.get(holding.id) : undefined;
    if (!portfolio) {
      order.push(holding);
      continue;
    }
    const members = membersByPortfolio.get(portfolio.id);
    if (members) {
      members.push(holding);
    } else {
      membersByPortfolio.set(portfolio.id, [holding]);
      order.push(portfolio);
    }
  }

  // Second pass: build each summand, now that every member set is complete.
  return order.map((entry) =>
    "holdingIds" in entry
      ? portfolioUnit(entry, membersByPortfolio.get(entry.id) ?? [])
      : {
          holding: entry,
          key: entry.id,
          kind: "holding" as const,
          signedMinor: signedMinor(entry),
        },
  );
}

/** One managed portfolio as a summand: its total, its rung, its instrument. */
function portfolioUnit(
  portfolio: ManagedPortfolioGrouping,
  members: UnifiedHolding[],
): BoardUnit {
  const byTier = new Map<UnifiedHolding["tier"], number>();
  const byInstrument = new Map<Instrument, number>();
  let signed = 0;
  for (const member of members) {
    const value = signedMinor(member);
    signed += value;
    byTier.set(member.tier, (byTier.get(member.tier) ?? 0) + value);
    byInstrument.set(
      member.instrument,
      (byInstrument.get(member.instrument) ?? 0) + value,
    );
  }

  return {
    instrument: dominant(byInstrument, "fund"),
    key: portfolio.id,
    kind: "portfolio",
    members: [...members].sort(
      (a, b) => signedMinor(b) - signedMinor(a) || a.id.localeCompare(b.id),
    ),
    portfolio,
    signedMinor: signed,
    tier: dominant(byTier, "market"),
  };
}

/**
 * Group a portfolio projection's summands by one axis (#154, #1548). Empty
 * groups are omitted; the order is meaningful (direction: Activos→Pasivos;
 * rung: ladder order; instrument: first-seen). The reconciliation invariant of
 * the projection is untouched — this only re-buckets the same rows.
 *
 * `managedPortfolios` is what makes a portfolio a block. Omit it and every
 * summand is a single holding: the behaviour before #1548, byte for byte.
 */
export function groupPortfolio(
  projection: PortfolioProjection,
  groupBy: PortfolioGroupKey,
  managedPortfolios: readonly ManagedPortfolioGrouping[] = [],
): PortfolioGroup[] {
  const units = buildUnits(unifyHoldings(projection), managedPortfolios);
  const currency = projection.totalGrossAssets.currency;
  const isAsset = (unit: BoardUnit) =>
    unit.kind === "portfolio" || unit.holding.direction === "asset";

  if (groupBy === "direction") {
    const assets = units.filter(isAsset);
    const liabilities = units.filter((unit) => !isAsset(unit));
    const groups: PortfolioGroup[] = [];
    if (assets.length > 0) groups.push(makeGroup("assets", "Activos", assets, currency));
    if (liabilities.length > 0) {
      groups.push(makeGroup("liabilities", "Pasivos", liabilities, currency));
    }
    return groups;
  }

  if (groupBy === "rung") {
    return LIQUIDITY_LADDER.map((rung) => {
      const inRung = units.filter((unit) => unitTier(unit) === rung);
      return inRung.length > 0
        ? makeGroup(rung, LIQUIDITY_TIER_LABELS[rung], inRung, currency)
        : null;
    }).filter((g): g is PortfolioGroup => g !== null);
  }

  // instrument — first-seen order keeps it stable without an arbitrary ranking.
  const order: Instrument[] = [];
  const byInstrument = new Map<Instrument, BoardUnit[]>();
  for (const unit of units) {
    const instrument = unitInstrument(unit);
    const list = byInstrument.get(instrument);
    if (list) {
      list.push(unit);
    } else {
      order.push(instrument);
      byInstrument.set(instrument, [unit]);
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

/** The rung a summand is filed under — a block's is its dominant one. */
function unitTier(unit: BoardUnit): UnifiedHolding["tier"] {
  return unit.kind === "portfolio" ? unit.tier : unit.holding.tier;
}

/** The instrument a summand is filed under — a block's is its dominant one. */
function unitInstrument(unit: BoardUnit): Instrument {
  return unit.kind === "portfolio" ? unit.instrument : unit.holding.instrument;
}
