import { holdingDetailHref, managedPortfolioFichaHref } from "@web/holding-route";
import type { ManagedPortfolio, ManualAsset } from "@worthline/domain";
import {
  computeManagedPortfolioFigures,
  type ManagedPortfolioSlice,
} from "@worthline/domain";

/**
 * View model for the carteras gestionadas surfaces (#1547).
 *
 * Everything the list and the ficha paint is decided here — pure and tested —
 * so neither page resolves a figure or an eligibility rule for itself. The
 * arithmetic of the composition (total + weights) lives in the domain
 * (`computeManagedPortfolioFigures`); this module feeds it and shapes output.
 */

/**
 * The holdings a portfolio may count as members: LIVE MANUAL INVESTMENTS only.
 *
 * The store re-asserts every rule at the door; this filter decides what the
 * form offers, and it must agree with it. A holding already belonging to
 * ANOTHER portfolio is not offered (membership is exclusive, ADR 0085) while
 * the edited portfolio's own members stay listed — unchecking them is how they
 * leave.
 */
export function managedPortfolioMemberOptions(input: {
  assets: readonly ManualAsset[];
  /** Internal portfolio id → the set of holdings it holds as members. */
  memberIdsByPortfolio: ReadonlyMap<string, ReadonlySet<string>>;
  /** The portfolio being edited, whose own members are never hidden. */
  portfolioId?: string | undefined;
}): ManualAsset[] {
  const { assets, memberIdsByPortfolio, portfolioId } = input;

  return assets.filter((asset) => {
    if (asset.type !== "investment") return false;
    if (asset.connectedSourceId != null) return false;

    for (const [ownerId, memberIds] of memberIdsByPortfolio) {
      if (ownerId !== portfolioId && memberIds.has(asset.id)) return false;
    }

    return true;
  });
}

export interface PortfolioListRowView {
  id: string;
  name: string;
  provider: string | null;
  /** Members + efectivo, derived on read — the same figure the ficha shows. */
  totalMinor: number;
  memberCount: number;
  /** The ficha link, or null when the registry has no row for the portfolio. */
  href: string | null;
}

export function portfolioListRowView(input: {
  portfolio: ManagedPortfolio;
  valueMinorByHoldingId: ReadonlyMap<string, number>;
  publicIdByPortfolio?: Readonly<Record<string, string>> | undefined;
}): PortfolioListRowView {
  const { portfolio, publicIdByPortfolio, valueMinorByHoldingId } = input;

  const totalMinor = portfolio.holdingIds.reduce(
    (sum, holdingId) => sum + (valueMinorByHoldingId.get(holdingId) ?? 0),
    0,
  );
  const publicId = publicIdByPortfolio?.[portfolio.id];

  return {
    href: publicId ? managedPortfolioFichaHref(publicId) : null,
    id: portfolio.id,
    memberCount: portfolio.holdingIds.length,
    name: portfolio.name,
    provider: portfolio.provider,
    totalMinor,
  };
}

export interface PortfolioCompositionRowView {
  holdingId: string;
  label: string;
  valueMinor: number;
  /** Share of the portfolio's total, 0..1 — null while the total is zero. */
  weight: number | null;
  /** True for the auto-created efectivo sibling, so the ficha can mark it. */
  isCash: boolean;
  /** The holding's own ficha link, or null without a registry row. */
  href: string | null;
}

/** The composition block of the ficha, everything decided before any JSX. */
export function portfolioCompositionView(input: {
  portfolio: ManagedPortfolio;
  valueMinorByHoldingId: ReadonlyMap<string, number>;
  nameById: ReadonlyMap<string, string>;
  typeByHoldingId: ReadonlyMap<string, string>;
  publicIdByHolding?: Readonly<Record<string, string>> | undefined;
}): {
  totalMinor: number;
  rows: PortfolioCompositionRowView[];
  /**
   * Members with no live holding behind them (trashed or hard-gone). They are
   * NOT silently dropped from the count: the ficha names them as invisible so
   * the Σ filas invariant stays honest.
   */
  unknownMemberIds: string[];
} {
  const {
    nameById,
    portfolio,
    publicIdByHolding,
    typeByHoldingId,
    valueMinorByHoldingId,
  } = input;

  const figures = computeManagedPortfolioFigures({
    members: portfolio.holdingIds.flatMap((holdingId) => {
      const valueMinor = valueMinorByHoldingId.get(holdingId);
      return valueMinor === undefined ? [] : [{ holdingId, valueMinor }];
    }),
  });

  const sliceByHoldingId = new Map(
    figures.slices.map((slice: ManagedPortfolioSlice) => [slice.holdingId, slice]),
  );
  const unknownMemberIds = portfolio.holdingIds.filter(
    (holdingId) => !sliceByHoldingId.has(holdingId),
  );

  // Composition reads by weight, largest first; the domain already ordered it.
  const rows: PortfolioCompositionRowView[] = figures.slices.map((slice) => ({
    holdingId: slice.holdingId,
    isCash: typeByHoldingId.get(slice.holdingId) === "cash",
    label: nameById.get(slice.holdingId) ?? slice.holdingId,
    valueMinor: slice.valueMinor,
    weight: slice.weight,
    href: publicIdByHolding?.[slice.holdingId]
      ? holdingDetailHref(publicIdByHolding[slice.holdingId]!)
      : null,
  }));

  return { rows, totalMinor: figures.totalMinor, unknownMemberIds };
}
