import { holdingDetailHref, managedPortfolioFichaHref } from "@web/holding-route";
import type {
  CurrencyCode,
  ManagedPortfolio,
  ManagedPortfolioReconciliation,
  ManagedPortfolioReconciliationState,
  ManualAsset,
  MoneyMinor,
} from "@worthline/domain";
import {
  computeManagedPortfolioFigures,
  formatDateKeyEs,
  formatDriftBps,
  formatMoneyMinor,
  type ManagedPortfolioSlice,
  managedPortfolioMemberValues,
  reconcileManagedPortfolio,
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

/** Everything the ficha's witness block paints, decided here (#1550). */
export interface PortfolioWitnessView {
  /** The investment members' value — the figure the witness is careed against. */
  investmentMinor: number;
  /** The container's cash, shown apart exactly as the manager's app shows it. */
  cashMinor: number;
  /** Cash included: what the portfolio contributes to the patrimonio. */
  totalMinor: number;
  declaredMinor: number | null;
  /** The declared date as `DD/MM/YYYY`, or null without a witness. */
  declaredDateLabel: string | null;
  /** The declared date as typed (`YYYY-MM-DD`) — the form's default value. */
  declaredDate: string | null;
  /** The signed drift ("−1,2 %"), or null when there was no careo. */
  driftLabel: string | null;
  state: ManagedPortfolioReconciliationState;
  /** True only past the threshold: the block renders as a warning, not a figure. */
  isDiverged: boolean;
  /** The sentence under the figures — always explicit about what was compared. */
  message: string;
}

/**
 * The reconciliation witness as the ficha reads it (#1550, ADR 0085).
 *
 * The careo itself is the domain's (`reconcileManagedPortfolio`), including the
 * rule that the container's cash stays out of it; this function only feeds it the
 * ficha's own read model and turns the verdict into text. A member that is no
 * longer live is skipped — it adds nothing to the derived total the ficha prints
 * either — while a LIVE member with no honest value in the base currency makes
 * the derived side incomplete and silences the careo instead of comparing a short
 * sum against the manager's full one.
 */
export function portfolioWitnessView(input: {
  portfolio: ManagedPortfolio;
  /** Live holdings' values in the currency they are HELD in (never converted). */
  moneyByHoldingId: ReadonlyMap<string, MoneyMinor>;
  /** Live holdings' types, keyed by id — absent means "not live any more". */
  typeByHoldingId: ReadonlyMap<string, string>;
  baseCurrency: CurrencyCode;
}): PortfolioWitnessView {
  const { baseCurrency, moneyByHoldingId, portfolio, typeByHoldingId } = input;

  // Unconverted money on purpose: the domain adds only what is natively in the
  // base currency, which is the SAME rule the data-health signal applies (it has
  // no FX layer). Feeding converted figures here would let this ficha claim a
  // drift the signal cannot see.
  const members = managedPortfolioMemberValues(
    portfolio.holdingIds,
    new Map(
      [...typeByHoldingId].map(([holdingId, type]) => [
        holdingId,
        { type, value: moneyByHoldingId.get(holdingId) ?? null },
      ]),
    ),
  );

  const reconciliation = reconcileManagedPortfolio({
    baseCurrency,
    members,
    witness: portfolio.witness,
  });

  const amount = (amountMinor: number) =>
    formatMoneyMinor({ amountMinor, currency: baseCurrency });
  const driftLabel =
    reconciliation.driftBps === null ? null : formatDriftBps(reconciliation.driftBps);
  const declaredDate = reconciliation.declaredDate;

  return {
    cashMinor: reconciliation.cashValue.amountMinor,
    declaredDate,
    declaredDateLabel: declaredDate === null ? null : formatDateKeyEs(declaredDate),
    declaredMinor: reconciliation.declaredValue?.amountMinor ?? null,
    driftLabel,
    investmentMinor: reconciliation.investmentValue.amountMinor,
    isDiverged: reconciliation.state === "diverged",
    message: witnessMessage(reconciliation, driftLabel, amount),
    state: reconciliation.state,
    totalMinor:
      reconciliation.investmentValue.amountMinor + reconciliation.cashValue.amountMinor,
  };
}

/**
 * The sentence the block carries. Every branch says what was compared against
 * what — a percentage with no stated operands is how a reader ends up trying to
 * reconcile it against the total and finding the cash missing.
 */
function witnessMessage(
  reconciliation: ManagedPortfolioReconciliation,
  driftLabel: string | null,
  amount: (amountMinor: number) => string,
): string {
  const threshold = `${(reconciliation.thresholdBps / 100).toFixed(0)} %`;

  switch (reconciliation.state) {
    case "no_witness":
      return (
        "Teclea el valor de mercado que lees en la app de tu gestor (el de los fondos, " +
        "sin la caja) y worthline lo careará contra lo que calcula por su cuenta. " +
        "Nunca sustituye a tus cifras: si se apartan, te avisa."
      );
    case "aligned":
      return (
        `Cuadra: el valor de tus fondos se aparta ${driftLabel} del saldo que ` +
        `declaraste, por debajo del ${threshold} desde el que worthline avisa. ` +
        `El efectivo de la cartera (${amount(reconciliation.cashValue.amountMinor)}) ` +
        "queda fuera del careo, igual que en la app de tu gestor."
      );
    case "diverged":
      return (
        `El valor de tus fondos se aparta ${driftLabel} del saldo que declaraste, ` +
        `más del ${threshold}. Manda lo que worthline calcula: revisa las ` +
        "participaciones, los precios o el propio saldo declarado. El efectivo " +
        `(${amount(reconciliation.cashValue.amountMinor)}) no entra en la comparación.`
      );
    case "not_comparable":
      switch (reconciliation.reason) {
        case "currency_mismatch":
          return (
            "El saldo declarado está en otra divisa que la de tu libro, así que no se " +
            "puede carear sin inventar un cambio. Declara el saldo en la divisa de " +
            "worthline."
          );
        case "incomplete_members":
          return (
            "Algún fondo de la cartera no está en tu divisa o no tiene hoy un valor " +
            "honesto, así que la suma que se carearía estaría incompleta. worthline no " +
            "compara medio total contra el total de tu gestor."
          );
        case "declared_not_positive":
          return (
            "El saldo declarado que hay guardado no es positivo, así que no hay deriva " +
            "relativa que medir. Vuelve a declararlo con el valor que leas hoy."
          );
        default:
          return (
            "La cartera todavía no tiene fondos con valor: el saldo declarado se " +
            "guarda, pero no hay nada contra lo que carearlo."
          );
      }
  }
}
