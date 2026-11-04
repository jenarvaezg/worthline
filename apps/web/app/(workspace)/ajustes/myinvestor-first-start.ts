/**
 * The first start of MyInvestor, pure (#1880, PRD #1876 S5; #1869 P2, P3 and P4):
 * from what the discovery found to the fold that chooses what to include, and from
 * the choice to the ONE batch that creates the holdings with their whole history.
 *
 * The operations are folded ONCE, here, for both: the value each row shows and the
 * rows the batch writes come from the same rows, so the fold can never promise a
 * figure the book will not hold (#1438).
 *
 * The cost (PRD #1876, invariant 3; ADR 0082):
 * - it is worthline's moving average, folded by `derivePosition`; MyInvestor's
 *   «invertido» is never read;
 * - an internal traspaso carries, on its `transfer_in`, exactly the cost its
 *   `transfer_out` takes out of the origin: the origin's position folded up to the
 *   leg that leaves, before and after it. The origin is folded from the discovery
 *   whether or not it is included, so the cost travels the same either way;
 * - an entry from another institution (or a leg nobody could pair) has no origin
 *   here: its inherited cost is PENDING (#1882 asks for it). Until then it carries
 *   the amount that arrived, the default of every external entry (no latent gain
 *   invented), valued at the nearest execution NAV of the same product when
 *   MyInvestor states no figure for it.
 */
import type {
  ConnectedHoldingCreation,
  IncludeConnectedHoldingsCommand,
} from "@worthline/db";
import type {
  CreateInvestmentOperationInput,
  DecimalString,
  InvestmentOperation,
  InvestmentPriceProvider,
  NormalizedFact,
  OwnershipShare,
} from "@worthline/domain";
import {
  compareInvestmentOperations,
  createInvestmentOperation,
  defaultsFor,
  derivePosition,
  divideUnits,
  isPositiveDecimal,
  multiplyToMinor,
  PRICE_READBACK_DECIMALS,
} from "@worthline/domain";
import type { MyInvestorOperationFact } from "@worthline/pricing";
import { myInvestorHoldingKey } from "@worthline/pricing";
import {
  holdsSomethingToday,
  type MyInvestorDiscoveredAccount,
  type MyInvestorDiscoveredProduct,
  type MyInvestorDiscovery,
  type MyInvestorProductKind,
} from "./myinvestor-discovery";
import type {
  MyInvestorAccountGroup,
  MyInvestorFirstStartView,
  MyInvestorInclusionBlock,
  MyInvestorProductRow,
  MyInvestorRung,
} from "./myinvestor-selection";

const EUR = "EUR";

/** A product's operations as worthline rows, with every inherited cost resolved. */
type FoldedRows = ReadonlyMap<string, readonly InvestmentOperation[]>;

/** The id an operation of this source gets in the book: stable per fact and per connection. */
export function myInvestorOperationId(sourceId: string, factKey: string): string {
  return `mi_${sourceId}_${factKey}`;
}

function productKeyOf(fact: MyInvestorOperationFact): string {
  return myInvestorHoldingKey(fact.accountId, fact.instrument);
}

function rungOf(kind: MyInvestorProductKind): MyInvestorRung {
  if (kind === "cash") return "liquid";
  if (kind === "plan") return "retirement";
  return "invested";
}

function toMinor(amount: DecimalString): number {
  return multiplyToMinor(amount, "1");
}

function pendingInheritedCost(fact: MyInvestorOperationFact): boolean {
  const transfer = fact.transfer;
  if (fact.operation !== "transfer_in" || transfer === null) return false;
  return transfer.pairing === "external_in" || transfer.pairing === "unpaired";
}

/**
 * The execution NAV of the same instrument closest in time, for an entry that states
 * no figure of its own (an external mobilization arrives with `cash: 0`).
 */
function nearestNav(
  fact: MyInvestorOperationFact,
  all: readonly NormalizedFact<MyInvestorOperationFact>[],
): DecimalString | null {
  let best: { distance: number; nav: DecimalString } | null = null;
  const at = Date.parse(fact.executedAt);
  for (const { payload } of all) {
    if (payload.instrument.code !== fact.instrument.code) continue;
    if (payload.pricePerUnit === null || !isPositiveDecimal(payload.pricePerUnit)) {
      continue;
    }
    const distance = Math.abs(Date.parse(payload.executedAt) - at);
    if (best === null || distance < best.distance) {
      best = { distance, nav: payload.pricePerUnit };
    }
  }
  return best?.nav ?? null;
}

/** The unit price a row states: the cash it moved over its units, as on a buy (#1544). */
function rowPrice(
  fact: MyInvestorOperationFact,
  all: readonly NormalizedFact<MyInvestorOperationFact>[],
): DecimalString {
  if (fact.amount !== null && isPositiveDecimal(fact.amount)) {
    return divideUnits(fact.amount, fact.units, PRICE_READBACK_DECIMALS);
  }
  return fact.pricePerUnit ?? nearestNav(fact, all) ?? "0";
}

/**
 * Every operation of the discovery as a worthline row, keyed by product, with the
 * inherited cost of each `transfer_in` resolved. Throws on a cycle of traspasos,
 * which no real history can have.
 */
export function foldMyInvestorOperations(
  discovery: MyInvestorDiscovery,
  sourceId: string,
): FoldedRows {
  const facts = discovery.operations;
  const byKey = new Map(facts.map((fact) => [fact.key, fact]));
  const resolved = new Map<string, InvestmentOperation>();
  const resolving = new Set<string>();
  const rowsByProduct = new Map<string, NormalizedFact<MyInvestorOperationFact>[]>();
  for (const fact of facts) {
    const key = productKeyOf(fact.payload);
    const list = rowsByProduct.get(key) ?? [];
    list.push(fact);
    rowsByProduct.set(key, list);
  }

  const baseInput = (
    fact: NormalizedFact<MyInvestorOperationFact>,
  ): CreateInvestmentOperationInput => {
    const { payload } = fact;
    const transferId = payload.transfer?.transferId;
    return {
      assetId: productKeyOf(payload),
      currency: payload.currency,
      executedAt: payload.executedAt,
      // A traspaso's commission rides its `transfer_in` (ADR 0082); MyInvestor
      // charges none on funds and plans, and the broker only buys and sells.
      feesMinor: payload.operation === "transfer_out" ? 0 : toMinor(payload.fees),
      id: myInvestorOperationId(sourceId, fact.key),
      kind: payload.operation,
      pricePerUnit: rowPrice(payload, facts),
      source: "connected",
      ...(transferId === undefined ? {} : { transferId }),
      units: payload.units,
    };
  };

  /** The cost a `transfer_out` takes out of its origin: the fold before and after it. */
  const costLeaving = (out: NormalizedFact<MyInvestorOperationFact>): number => {
    const outRow = resolve(out);
    const origin = rowsByProduct.get(productKeyOf(out.payload)) ?? [];
    const before = origin
      .map(resolve)
      .filter((row) => compareInvestmentOperations(row, outRow) < 0);
    const options = { assetId: outRow.assetId, currency: outRow.currency };
    const held = derivePosition(before, options).costBasis.amountMinor;
    const left = derivePosition([...before, outRow], options).costBasis.amountMinor;
    return Math.max(0, held - left);
  };

  const inheritedCost = (fact: NormalizedFact<MyInvestorOperationFact>): number => {
    const transfer = fact.payload.transfer;
    if (transfer?.pairing === "paired") {
      const out = byKey.get(transfer.counterpartKey);
      if (out && out.payload.operation === "transfer_out") return costLeaving(out);
    }
    // No origin in MyInvestor: the amount that arrived, pending until #1882 asks.
    if (fact.payload.amount !== null && isPositiveDecimal(fact.payload.amount)) {
      return toMinor(fact.payload.amount);
    }
    return multiplyToMinor(fact.payload.units, rowPrice(fact.payload, facts));
  };

  function resolve(fact: NormalizedFact<MyInvestorOperationFact>): InvestmentOperation {
    const done = resolved.get(fact.key);
    if (done) return done;
    if (resolving.has(fact.key)) {
      throw new Error(`MyInvestor traspasos form a cycle at ${fact.key}.`);
    }
    resolving.add(fact.key);
    const input = baseInput(fact);
    const row = createInvestmentOperation(
      fact.payload.operation === "transfer_in"
        ? { ...input, transferCostMinor: inheritedCost(fact) }
        : input,
    );
    resolving.delete(fact.key);
    resolved.set(fact.key, row);
    return row;
  }

  const folded = new Map<string, InvestmentOperation[]>();
  for (const [key, list] of rowsByProduct) {
    folded.set(key, list.map(resolve).sort(compareInvestmentOperations));
  }
  return folded;
}

/**
 * The fold that chooses what to include, by account as the bank shows them. Pure.
 *
 * `manualTwins` maps an ISIN or DGS code to the name of a live MANUAL holding that
 * already carries it (#1881's careo is not here yet); `linkedKeys` are the products
 * already linked.
 */
export function myInvestorFirstStartView(
  discovery: MyInvestorDiscovery,
  input: {
    sourceId: string;
    linkedKeys: ReadonlySet<string>;
    manualTwins: ReadonlyMap<string, string>;
  },
): MyInvestorFirstStartView {
  const folded = foldMyInvestorOperations(discovery, input.sourceId);
  const factsByProduct = new Map<string, MyInvestorOperationFact[]>();
  for (const { payload } of discovery.operations) {
    const key = productKeyOf(payload);
    const list = factsByProduct.get(key) ?? [];
    list.push(payload);
    factsByProduct.set(key, list);
  }

  const rowOf = (product: MyInvestorDiscoveredProduct): MyInvestorProductRow => {
    const rows = folded.get(product.key) ?? [];
    const facts = factsByProduct.get(product.key) ?? [];
    const twin =
      product.instrument === null
        ? undefined
        : input.manualTwins.get(product.instrument.code);
    const block: MyInvestorInclusionBlock | null =
      product.kind === "managed"
        ? { reason: "managed_portfolio" }
        : twin !== undefined
          ? { holdingName: twin, reason: "manual_twin" }
          : facts.some((fact) => fact.currency !== EUR) ||
              (product.cash !== null && product.cash.currency !== EUR)
            ? { reason: "currency" }
            : null;
    const valueMinor =
      product.cash !== null
        ? toMinor(product.cash.balance)
        : derivePosition([...rows], { assetId: product.key, currency: EUR }).costBasis
            .amountMinor;
    const withheld = product.cash?.withheld ?? null;
    const linked = input.linkedKeys.has(product.key);
    return {
      accountKey: product.accountKey,
      block,
      identifier: product.identifier,
      inheritedCostPending: facts.some(pendingInheritedCost),
      key: product.key,
      kind: product.kind,
      linked,
      members: product.members,
      name: product.name,
      operations: rows.length,
      otherHolder: product.otherHolder,
      rung: rungOf(product.kind),
      selectedByDefault:
        !linked && block === null && !product.otherHolder && holdsSomethingToday(product),
      since: rows[0]?.executedAt.slice(0, 10) ?? null,
      units: product.units,
      valueMinor,
      withheldMinor:
        withheld !== null && isPositiveDecimal(withheld) ? toMinor(withheld) : null,
    };
  };

  const rows = discovery.products.map(rowOf);
  const groups = discovery.accounts.map((account) => ({
    account,
    products: rows.filter((row) => row.accountKey === account.key),
  }));
  return {
    others: groups.filter((group) => group.account.otherHolder),
    own: groups.filter((group) => !group.account.otherHolder),
    readOn: discovery.readOn,
    rows,
  };
}

/** A price-provider symbol found for a product's ISIN or DGS code, when one was. */
export interface MyInvestorPriceSymbol {
  readonly provider: InvestmentPriceProvider;
  readonly symbol: string;
}

export type MyInvestorInclusionPlan =
  | { readonly ok: true; readonly command: IncludeConnectedHoldingsCommand }
  | { readonly ok: false; readonly error: string };

const KIND_INSTRUMENT = {
  etf: "etf",
  fund: "fund",
  plan: "pension_plan",
  stock: "stock",
} as const;

/**
 * The batch that includes the chosen products. Pure: ids, ownership and price
 * symbols are the caller's. Refuses a product that is unknown, already linked or
 * another slice's; nothing is half-planned.
 */
export function planMyInvestorInclusion(
  discovery: MyInvestorDiscovery,
  input: {
    sourceId: string;
    today: string;
    productKeys: readonly string[];
    view: MyInvestorFirstStartView;
    ownership: OwnershipShare[];
    assetIdFor: (productKey: string) => string;
    symbols: ReadonlyMap<string, MyInvestorPriceSymbol | null>;
  },
): MyInvestorInclusionPlan {
  const keys = [...new Set(input.productKeys)];
  if (keys.length === 0) {
    return { error: "Marca al menos un producto para incluirlo.", ok: false };
  }
  const rowByKey = new Map(input.view.rows.map((row) => [row.key, row]));
  const productByKey = new Map(
    discovery.products.map((product) => [product.key, product]),
  );
  for (const key of keys) {
    const row = rowByKey.get(key);
    if (!row || !productByKey.has(key)) {
      return {
        error: "Ese producto ya no está en lo que leímos de MyInvestor. Vuelve a leerlo.",
        ok: false,
      };
    }
    if (row.linked) return { error: `«${row.name}» ya está incluido.`, ok: false };
    if (row.block !== null) {
      return { error: `«${row.name}» aún no se puede incluir.`, ok: false };
    }
  }

  const folded = foldMyInvestorOperations(discovery, input.sourceId);
  const holdings: ConnectedHoldingCreation[] = [];
  const facts: NormalizedFact<CreateInvestmentOperationInput>[] = [];
  const factKeyById = new Map(
    discovery.operations.map((fact) => [
      myInvestorOperationId(input.sourceId, fact.key),
      fact.key,
    ]),
  );

  for (const key of keys) {
    const product = productByKey.get(key)!;
    const assetId = input.assetIdFor(key);
    if (product.kind === "cash" && product.cash !== null) {
      holdings.push({
        holding: {
          asset: {
            currency: EUR,
            currentValueMinor: toMinor(product.cash.balance),
            id: assetId,
            instrument: "current_account",
            liquidityTier: defaultsFor("current_account").rung,
            name: product.name,
            ownership: input.ownership,
            type: "cash",
          },
          kind: "cash",
        },
        productKey: key,
      });
      continue;
    }
    if (
      product.instrument === null ||
      product.kind === "managed" ||
      product.kind === "cash"
    ) {
      return { error: `«${product.name}» aún no se puede incluir.`, ok: false };
    }
    const instrument = KIND_INSTRUMENT[product.kind];
    const symbol = input.symbols.get(key) ?? null;
    holdings.push({
      holding: {
        asset: {
          currency: EUR,
          id: assetId,
          instrument,
          liquidityTier: defaultsFor(instrument).rung,
          name: product.name,
          ownership: input.ownership,
          securityId: { kind: product.instrument.scheme, value: product.instrument.code },
          ...(symbol
            ? { priceProvider: symbol.provider, providerSymbol: symbol.symbol }
            : {}),
        },
        kind: "investment",
      },
      productKey: key,
    });
    for (const row of folded.get(key) ?? []) {
      const factKey = factKeyById.get(row.id);
      if (factKey === undefined) continue;
      facts.push({
        dateKey: row.executedAt.slice(0, 10),
        key: factKey,
        payload: operationInput(row, assetId),
      });
    }
  }

  return {
    command: {
      facts: { cursor: discovery.readOn, facts },
      holdings,
      sourceId: input.sourceId,
      today: input.today,
    },
    ok: true,
  };
}

/** A folded row back as the input that writes it, into the holding it belongs to. */
function operationInput(
  row: InvestmentOperation,
  assetId: string,
): CreateInvestmentOperationInput {
  return {
    assetId,
    currency: row.currency,
    executedAt: row.executedAt,
    feesMinor: row.feesMinor,
    id: row.id,
    kind: row.kind,
    pricePerUnit: row.pricePerUnit,
    source: "connected",
    ...(row.transferId === undefined ? {} : { transferId: row.transferId }),
    ...(row.transferCostMinor === undefined
      ? {}
      : { transferCostMinor: row.transferCostMinor }),
    units: row.units,
  };
}
