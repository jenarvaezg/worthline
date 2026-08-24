import { resolveFxAggregation } from "@web/fx-context";
import { managedPortfolioPublicIdIndex } from "@web/holding-route";
import type { WorthlineStore } from "@web/store";
import type {
  CurrencyCode,
  ManagedPortfolio,
  ManualAsset,
  MoneyMinor,
} from "@worthline/domain";

/**
 * Shared read model behind the carteras gestionadas surfaces (#1547) — sibling
 * of `loadPatrimonio`: one input in, everything both the index and the ficha
 * paint out. Cache-only GET (#785 discipline): reads the store and the curve-
 * valued ledger, hits the network only when a foreign currency is actually
 * held (the hard-gated FX rule every aggregation obeys).
 *
 * Member values come from the SAME engine the board uses
 * (`readCurveValuedHoldingsAtDate`), so the ficha can never quote a number the
 * board disagrees with — the portfolio's total is just the sum of its members.
 */

export interface LoadCarterasInput {
  store: WorthlineStore;
  baseCurrency: CurrencyCode;
  /** The selected scope id, or undefined to skip the scoped listing. */
  scopeId: string | undefined;
  /** "Today" as YYYY-MM-DD — anchors curve valuation and FX. */
  today: string;
}

export interface CarterasReadModel {
  /**
   * The selected scope's portfolios, ordered by name. Empty when no scope is
   * selected — never "everybody's".
   */
  portfolios: ManagedPortfolio[];
  /**
   * Every live holding's value at `today`, converted to the workspace's base
   * currency when needed. Holdings whose currency cannot be converted are
   * absent (counted in {@link excludedForeignCount}) — never guessed at 1:1.
   */
  valueMinorByHoldingId: ReadonlyMap<string, number>;
  /** Every live holding's name (members' labels), keyed by internal id. */
  nameById: ReadonlyMap<string, string>;
  /** Every live holding's type, so the ficha can mark the efectivo row. */
  typeByHoldingId: ReadonlyMap<string, string>;
  /**
   * Every live holding's value in the currency it is HELD in — unconverted
   * (#1550). The careo of the declared balance reads this one, not the converted
   * figures above: the data-health signal has no FX layer, so careing a
   * converted sum here would let the ficha and the signal reach different
   * verdicts about the same cartera (#1422). The composition and the totals keep
   * using the converted values, which is what the patrimonio is made of.
   */
  moneyByHoldingId: ReadonlyMap<string, MoneyMinor>;
  /** The live curve-valued holdings — what the member chips offer from. */
  assets: readonly ManualAsset[];
  /** Internal portfolio id → public `wl_prt_…` id (ficha links). */
  publicIdByPortfolio: Readonly<Record<string, string>>;
  /** Internal portfolio id → its member set (exclusivity-aware options). */
  memberIdsByPortfolio: ReadonlyMap<string, ReadonlySet<string>>;
  /** All portfolios regardless of scope — the exclusivity check is global. */
  allPortfolios: ManagedPortfolio[];
  /**
   * Live holdings left OUT of {@link valueMinorByHoldingId} because their
   * currency has no honest conversion at `today`. Counted, never guessed.
   */
  excludedForeignCount: number;
}

export async function loadCarteras(input: LoadCarterasInput): Promise<CarterasReadModel> {
  const { baseCurrency, scopeId, store, today } = input;

  const projectionContext = await store.snapshots.buildProjectionContext();
  const [curveValued, portfolios, publicIds] = await Promise.all([
    store.snapshots.readCurveValuedHoldingsAtDate(today, projectionContext),
    store.managedPortfolios.readManagedPortfolios(),
    store.agentView.readPublicIds(),
  ]);

  const moneyByHolding = new Map<string, MoneyMinor>(
    curveValued.assets.map((asset) => [asset.id, asset.currentValue]),
  );

  // Hard-gated FX (#1065): all-base workspaces pay nothing; a foreign member
  // costs exactly one ECB fetch. A rate ECB cannot print excludes that holding
  // from the derived figures instead of pretending an exchange rate.
  const fx = await resolveFxAggregation([...moneyByHolding.values()], today);

  let excludedForeignCount = 0;
  const valueMinorByHoldingId = new Map<string, number>();
  for (const [holdingId, money] of moneyByHolding) {
    if (!fx) {
      if (money.currency === baseCurrency) {
        valueMinorByHoldingId.set(holdingId, money.amountMinor);
      } else {
        excludedForeignCount += 1;
      }
      continue;
    }

    const converted = fx.converter.convert(money, baseCurrency, today);
    if (converted.ok) {
      valueMinorByHoldingId.set(holdingId, converted.value.amountMinor);
    } else {
      excludedForeignCount += 1;
    }
  }

  // The store orders portfolios by name (then id) — one ordering owner.
  const allPortfolios = portfolios;
  const scoped = scopeId
    ? allPortfolios.filter((portfolio) => portfolio.scopeId === scopeId)
    : [];

  return {
    allPortfolios,
    assets: curveValued.assets,
    memberIdsByPortfolio: new Map(
      allPortfolios.map((portfolio) => [portfolio.id, new Set(portfolio.holdingIds)]),
    ),
    nameById: new Map(curveValued.assets.map((asset) => [asset.id, asset.name])),
    portfolios: scoped,
    publicIdByPortfolio: Object.fromEntries(
      managedPortfolioPublicIdIndex(publicIds).publicByInternal,
    ),
    moneyByHoldingId: moneyByHolding,
    typeByHoldingId: new Map(curveValued.assets.map((asset) => [asset.id, asset.type])),
    valueMinorByHoldingId,
    excludedForeignCount,
  };
}
