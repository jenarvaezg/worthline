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
 *   MyInvestor states no figure for it. The row carries the `cost_pending` mark,
 *   so the ficha asks for the real cost and never shows this one as a figure;
 * - an outgoing leg nobody could pair is written as the sale it reads as, marked
 *   `unpaired_out`, until the user confirms which entry it funded (#1882, ADR 0115
 *   as amended 2026-11-04): then the two become one traspaso and the cost travels.
 *
 * A product a live manual holding already is (#1881) is not created again unless
 * the user says so: it is LINKED, and the same folded rows replace the holding's
 * manual operations. Its careo comes from those rows too.
 */
import type {
  ConnectedHoldingCreation,
  ConnectedHoldingLink,
  HoldingContributionPlan,
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
import { myInvestorCareo, myInvestorNamesAlike } from "./myinvestor-careo";
import {
  holdsSomethingToday,
  type MyInvestorDiscoveredAccount,
  type MyInvestorDiscoveredProduct,
  type MyInvestorDiscovery,
  type MyInvestorProductKind,
} from "./myinvestor-discovery";
import {
  type MyInvestorAccountGroup,
  type MyInvestorFirstStartView,
  type MyInvestorInclusionBlock,
  type MyInvestorProductRow,
  type MyInvestorRung,
  type MyInvestorTwin,
  type MyInvestorTwinChoice,
  myInvestorLinkChoice,
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

/** An outgoing traspaso leg the adapter could not tie to its other half (#1882). */
function unpairedOut(fact: MyInvestorOperationFact): boolean {
  return fact.operation === "transfer_out" && fact.transfer?.pairing === "unpaired";
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
 * inherited cost of each `transfer_in` resolved. Each cost depends only on rows
 * earlier in its origin's ledger, so the dependencies follow time and a round trip
 * (A → B, later B → A) resolves; a cycle could only come from two legs of one day
 * ordered against each other, and it throws instead of guessing.
 */
/** The ledger's own order (`compareInvestmentOperations`: day, then id), from a fact. */
function compareLedgerOrder(
  left: NormalizedFact<MyInvestorOperationFact>,
  right: NormalizedFact<MyInvestorOperationFact>,
): number {
  const byDay = left.payload.executedAt
    .slice(0, 10)
    .localeCompare(right.payload.executedAt.slice(0, 10));
  return byDay !== 0 ? byDay : left.key.localeCompare(right.key);
}

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
    const common = {
      assetId: productKeyOf(payload),
      currency: payload.currency,
      executedAt: payload.executedAt,
      id: myInvestorOperationId(sourceId, fact.key),
      pricePerUnit: rowPrice(payload, facts),
      source: "connected" as const,
      units: payload.units,
    };
    // An outgoing leg nothing tied to its entry is, until the user confirms where
    // it went (#1882), what it reads as: a sale. A lone `transfer_out` would take
    // the capital out of the book with neither a destination nor a gain, and the
    // traspaso audit reads it as broken. The mark keeps it findable as a candidate.
    if (unpairedOut(payload)) {
      return { ...common, feesMinor: 0, kind: "sell", transferLegState: "unpaired_out" };
    }
    const transferId = payload.transfer?.transferId;
    return {
      ...common,
      // A traspaso's commission rides its `transfer_in` (ADR 0082); MyInvestor
      // charges none on funds and plans, and the broker only buys and sells.
      feesMinor: payload.operation === "transfer_out" ? 0 : toMinor(payload.fees),
      kind: payload.operation,
      ...(transferId === undefined ? {} : { transferId }),
      // The entry with no origin carries a provisional cost; the mark is what lets
      // the ficha ask for the real one and never show this one as a figure.
      ...(pendingInheritedCost(payload)
        ? { transferLegState: "cost_pending" as const }
        : {}),
    };
  };

  /** The cost a `transfer_out` takes out of its origin: the fold before and after it. */
  const costLeaving = (out: NormalizedFact<MyInvestorOperationFact>): number => {
    const outRow = resolve(out);
    const origin = rowsByProduct.get(productKeyOf(out.payload)) ?? [];
    // Only the rows BEFORE the leg that leaves are resolved: a later entry into the
    // origin (capital that comes back) has a cost of its own that may depend on this
    // one, and resolving it here would chase its tail. The ledger order needs no cost.
    const before = origin
      .filter((fact) => compareLedgerOrder(fact, out) < 0)
      .map(resolve);
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

/** A live MANUAL investment, as the twin search needs it (#1881). */
export interface MyInvestorManualHolding {
  readonly id: string;
  readonly name: string;
  /** The ISIN or DGS code it carries; null when it carries none. */
  readonly code: string | null;
}

/** Which manual holdings a product may be, before their ledgers are read. */
export interface MyInvestorTwinMatch {
  readonly reason: MyInvestorTwin["reason"];
  readonly scheme: MyInvestorTwin["scheme"];
  readonly holdings: readonly MyInvestorManualHolding[];
}

/**
 * The manual twins of each product not linked yet (#1881, #1869 P3). Pure.
 *
 * - **Strong**: a holding that carries the product's ISIN or DGS code. A manual
 *   holding has no account, so the code is all there is to compare.
 * - **Suggestion**: only when there is no strong one, a holding that carries no
 *   identifier and whose name is alike. It is never ticked.
 *
 * Cash and a managed portfolio have no units to compare: they never have a twin.
 */
export function findMyInvestorTwins(
  discovery: MyInvestorDiscovery,
  input: {
    manual: readonly MyInvestorManualHolding[];
    linkedKeys: ReadonlySet<string>;
  },
): Map<string, MyInvestorTwinMatch> {
  const twins = new Map<string, MyInvestorTwinMatch>();
  for (const product of discovery.products) {
    if (product.instrument === null || input.linkedKeys.has(product.key)) continue;
    const { code, scheme } = product.instrument;
    const strong = input.manual.filter((holding) => holding.code === code);
    if (strong.length > 0) {
      twins.set(product.key, { holdings: strong, reason: "identifier", scheme });
      continue;
    }
    const alike = input.manual.filter(
      (holding) =>
        holding.code === null && myInvestorNamesAlike(product.name, holding.name),
    );
    if (alike.length > 0) {
      twins.set(product.key, { holdings: alike, reason: "name", scheme });
    }
  }
  return twins;
}

/** What the careo of one candidate needs of its manual holding. */
export interface MyInvestorTwinLedger {
  readonly operations: readonly InvestmentOperation[];
  /** The two prices its valuation reads: the usable cached quote and the hand-set one. */
  readonly cachedPrice?: DecimalString;
  readonly manualPrice?: DecimalString;
  readonly plan: HoldingContributionPlan | null;
  /** The holdings holding the other half of one of its traspasos, with their names. */
  readonly pairedWith: readonly { readonly assetId: string; readonly name: string }[];
}

/**
 * The fold that chooses what to include, by account as the bank shows them. Pure.
 *
 * `twins` are the manual holdings each product may be ({@link findMyInvestorTwins}),
 * and `ledgers` what was read of each of them, by holding id, for its careo;
 * `linkedKeys` are the products already linked.
 */
export function myInvestorFirstStartView(
  discovery: MyInvestorDiscovery,
  input: {
    sourceId: string;
    linkedKeys: ReadonlySet<string>;
    twins: ReadonlyMap<string, MyInvestorTwinMatch>;
    ledgers: ReadonlyMap<string, MyInvestorTwinLedger>;
    today: string;
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

  // Only one product opens set to link a given holding: the same ISIN in two
  // accounts would otherwise both claim it, and the batch refuses that.
  const claimed = new Set<string>();
  const twinOf = (
    product: MyInvestorDiscoveredProduct,
    rows: readonly InvestmentOperation[],
  ): MyInvestorTwin | null => {
    const match = input.twins.get(product.key);
    if (!match) return null;
    const candidates = match.holdings.map((holding) => {
      const ledger = input.ledgers.get(holding.id);
      return {
        assetId: holding.id,
        careo: myInvestorCareo({
          manual: ledger?.operations ?? [],
          plan: ledger?.plan ?? null,
          source: rows,
          today: input.today,
          ...(ledger?.cachedPrice ? { cachedPrice: ledger.cachedPrice } : {}),
          ...(ledger?.manualPrice ? { manualPrice: ledger.manualPrice } : {}),
        }),
        name: holding.name,
        pairedWith: ledger?.pairedWith ?? [],
      };
    });
    const only = candidates.length === 1 ? candidates[0]! : null;
    let defaultChoice: MyInvestorTwinChoice = "skip";
    if (
      match.reason === "identifier" &&
      only !== null &&
      !product.otherHolder &&
      !claimed.has(only.assetId)
    ) {
      claimed.add(only.assetId);
      defaultChoice = myInvestorLinkChoice(only.assetId);
    }
    return { candidates, defaultChoice, reason: match.reason, scheme: match.scheme };
  };

  const rowOf = (product: MyInvestorDiscoveredProduct): MyInvestorProductRow => {
    const rows = folded.get(product.key) ?? [];
    const facts = factsByProduct.get(product.key) ?? [];
    const block: MyInvestorInclusionBlock | null =
      product.kind === "managed"
        ? { reason: "managed_portfolio" }
        : facts.some((fact) => fact.currency !== EUR) ||
            (product.cash !== null && product.cash.currency !== EUR)
          ? { reason: "currency" }
          : null;
    const linked = input.linkedKeys.has(product.key);
    const twin = block === null && !linked ? twinOf(product, rows) : null;
    const valueMinor =
      product.cash !== null
        ? toMinor(product.cash.balance)
        : derivePosition([...rows], { assetId: product.key, currency: EUR }).costBasis
            .amountMinor;
    const withheld = product.cash?.withheld ?? null;
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
        !linked &&
        block === null &&
        twin === null &&
        !product.otherHolder &&
        holdsSomethingToday(product),
      since: rows[0]?.executedAt.slice(0, 10) ?? null,
      twin,
      units: product.units,
      valueMinor,
      withheldMinor:
        withheld !== null && isPositiveDecimal(withheld) ? toMinor(withheld) : null,
    };
  };

  const rows = settleTwinDefaults(discovery.products.map(rowOf));
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

/**
 * A default «Enlazar» stands only if every traspaso of its holding is linked with
 * it: a half left behind would be refused by the batch (#1393). Repeated until
 * nothing changes, since unlinking one can strand another.
 */
function settleTwinDefaults(rows: MyInvestorProductRow[]): MyInvestorProductRow[] {
  let settled = rows;
  for (;;) {
    const linking = new Set(
      settled.flatMap((row) => {
        const choice = row.twin?.defaultChoice ?? "skip";
        return choice.startsWith("link:") ? [choice.slice("link:".length)] : [];
      }),
    );
    let changed = false;
    settled = settled.map((row) => {
      const twin = row.twin;
      if (!twin || !twin.defaultChoice.startsWith("link:")) return row;
      const assetId = twin.defaultChoice.slice("link:".length);
      const candidate = twin.candidates.find((item) => item.assetId === assetId);
      if (!candidate || candidate.pairedWith.every((pair) => linking.has(pair.assetId))) {
        return row;
      }
      changed = true;
      return { ...row, twin: { ...twin, defaultChoice: "skip" } };
    });
    if (!changed) return settled;
  }
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

/** A product to link to one of its manual twins (#1881). */
export interface MyInvestorLinkChoice {
  readonly productKey: string;
  readonly assetId: string;
}

/**
 * The batch that includes the chosen products and links the chosen twins. Pure:
 * ids, ownership and price symbols are the caller's. Refuses a product that is
 * unknown, already linked or another slice's, a link to a holding that is not one of
 * the product's twins, and a holding claimed twice; nothing is half-planned.
 */
export function planMyInvestorInclusion(
  discovery: MyInvestorDiscovery,
  input: {
    sourceId: string;
    today: string;
    productKeys: readonly string[];
    /** Twins to link (#1881); none when absent. */
    links?: readonly MyInvestorLinkChoice[];
    view: MyInvestorFirstStartView;
    ownership: OwnershipShare[];
    assetIdFor: (productKey: string) => string;
    symbols: ReadonlyMap<string, MyInvestorPriceSymbol | null>;
  },
): MyInvestorInclusionPlan {
  const keys = [...new Set(input.productKeys)];
  const links = input.links ?? [];
  if (keys.length === 0 && links.length === 0) {
    return { error: "Marca al menos un producto para incluirlo.", ok: false };
  }
  const rowByKey = new Map(input.view.rows.map((row) => [row.key, row]));
  const productByKey = new Map(
    discovery.products.map((product) => [product.key, product]),
  );
  const claimed = new Map<string, string>();
  for (const link of links) {
    const row = rowByKey.get(link.productKey);
    if (!row || !productByKey.has(link.productKey)) {
      return {
        error: "Ese producto ya no está en lo que leímos de MyInvestor. Vuelve a leerlo.",
        ok: false,
      };
    }
    if (row.linked) return { error: `«${row.name}» ya está incluido.`, ok: false };
    const candidate = row.twin?.candidates.find((item) => item.assetId === link.assetId);
    if (row.block !== null || !candidate) {
      return { error: `«${row.name}» no se puede enlazar con ese holding.`, ok: false };
    }
    if (keys.includes(link.productKey)) {
      return {
        error: `«${row.name}» se enlaza o se crea aparte, no las dos cosas.`,
        ok: false,
      };
    }
    const other = claimed.get(link.assetId);
    if (other !== undefined) {
      return {
        error: `«${candidate.name}» solo se puede enlazar con un producto: elige entre «${other}» y «${row.name}».`,
        ok: false,
      };
    }
    claimed.set(link.assetId, row.name);
  }
  // A traspaso is replaced whole or not at all (#1393): both its holdings link.
  for (const link of links) {
    const row = rowByKey.get(link.productKey)!;
    const candidate = row.twin!.candidates.find((item) => item.assetId === link.assetId)!;
    const stranded = candidate.pairedWith.find((pair) => !claimed.has(pair.assetId));
    if (stranded) {
      return {
        error: `«${candidate.name}» tiene un traspaso con «${stranded.name}»: enlaza los dos a la vez, o deshaz el traspaso antes.`,
        ok: false,
      };
    }
  }
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

  const linkCommands: ConnectedHoldingLink[] = [];
  for (const link of links) {
    const row = rowByKey.get(link.productKey)!;
    const product = productByKey.get(link.productKey)!;
    linkCommands.push({
      assetId: link.assetId,
      productKey: link.productKey,
      // Alike only by name, the holding carries no identifier: it takes this one.
      ...(row.twin?.reason === "name" && product.instrument
        ? {
            securityId: {
              kind: product.instrument.scheme,
              value: product.instrument.code,
            },
          }
        : {}),
    });
    for (const operation of folded.get(link.productKey) ?? []) {
      const factKey = factKeyById.get(operation.id);
      if (factKey === undefined) continue;
      facts.push({
        dateKey: operation.executedAt.slice(0, 10),
        key: factKey,
        payload: operationInput(operation, link.assetId),
      });
    }
  }

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
      links: linkCommands,
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
    ...(row.transferLegState === undefined
      ? {}
      : { transferLegState: row.transferLegState }),
    units: row.units,
  };
}
