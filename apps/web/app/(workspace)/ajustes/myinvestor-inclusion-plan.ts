/**
 * The ONE batch of «Incluir con su histórico» (#1880, PRD #1876 S5): from the
 * choice in the first start's fold to the command that creates the chosen
 * holdings with their whole history, links the chosen twins (#1881) and brings or
 * takes over the robo-advisor's portfolios (#1883). Pure: ids, ownership and price
 * symbols are the caller's.
 */
import type {
  ConnectedCashLink,
  ConnectedHoldingCreation,
  ConnectedHoldingLink,
  ConnectedPortfolioCreation,
  ConnectedPortfolioLink,
  IncludeConnectedHoldingsCommand,
} from "@worthline/db";
import type {
  CreateInvestmentOperationInput,
  InvestmentPriceProvider,
  NormalizedFact,
  OwnershipShare,
} from "@worthline/domain";
import { defaultsFor } from "@worthline/domain";
import type {
  MyInvestorDiscoveredProduct,
  MyInvestorDiscovery,
} from "./myinvestor-discovery";
import {
  entryOfSoldOrigin,
  foldMyInvestorOperations,
  myInvestorOperationId,
  operationInput,
  pendingEntryOfSoldOrigin,
  toMinor,
} from "./myinvestor-operations-fold";
import { myInvestorPortfolioParts } from "./myinvestor-portfolio";
import {
  isPortfolioLinkable,
  type MyInvestorFirstStartView,
  type MyInvestorPortfolioCandidate,
  type MyInvestorProductRow,
  myInvestorLinkChoice,
  myInvestorPortfolioBlockedReason,
  portfolioOfChoice,
} from "./myinvestor-selection";

const EUR = "EUR";

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
 *
 * A robo-advisor's block (#1883) is included as ONE managed portfolio — its funds,
 * those the manager sold whole too, and its cash as the sibling, with the declared
 * balance as witness — or linked with a portfolio kept by hand, whole: each fund to
 * the member of its ISIN, the cash to the sibling, the funds it lacked created into
 * it. A blocked portfolio is refused with the reason the fold shows.
 */
export function planMyInvestorInclusion(
  discovery: MyInvestorDiscovery,
  input: {
    sourceId: string;
    today: string;
    productKeys: readonly string[];
    /** Twins to link (#1881) and portfolios kept by hand (#1883); none when absent. */
    links?: readonly MyInvestorLinkChoice[];
    view: MyInvestorFirstStartView;
    ownership: OwnershipShare[];
    assetIdFor: (productKey: string) => string;
    symbols: ReadonlyMap<string, MyInvestorPriceSymbol | null>;
    /**
     * The ids of the sales `unpaired_out` the linked holdings' books already hold
     * (#1882): an entry whose way out is one of them goes in with its cost pending,
     * as the sync writes it. None when absent.
     */
    soldUnpairedOutIds?: ReadonlySet<string>;
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
  const gone = {
    error: "Ese producto ya no está en lo que leímos de MyInvestor. Vuelve a leerlo.",
    ok: false as const,
  };
  const claimed = new Map<string, string>();
  const holdingLinks: { link: MyInvestorLinkChoice; row: MyInvestorProductRow }[] = [];
  const portfolioLinks: {
    candidate: MyInvestorPortfolioCandidate;
    row: MyInvestorProductRow;
  }[] = [];
  for (const link of links) {
    const row = rowByKey.get(link.productKey);
    if (!row || !productByKey.has(link.productKey)) return gone;
    if (row.linked) return { error: `«${row.name}» ya está incluido.`, ok: false };
    if (keys.includes(link.productKey)) {
      return {
        error: `«${row.name}» se enlaza o se crea aparte, no las dos cosas.`,
        ok: false,
      };
    }
    const portfolio = portfolioOfChoice(row, myInvestorLinkChoice(link.assetId));
    if (row.block === null && portfolio !== null) {
      if (!isPortfolioLinkable(portfolio)) {
        return { error: myInvestorPortfolioBlockedReason(portfolio), ok: false };
      }
      const other = claimed.get(portfolio.portfolioId);
      if (other !== undefined) {
        return {
          error: `«${portfolio.name}» solo se puede enlazar con una cartera: elige entre «${other}» y «${row.name}».`,
          ok: false,
        };
      }
      claimed.set(portfolio.portfolioId, row.name);
      for (const member of portfolio.members) {
        if (member.assetId !== null) claimed.set(member.assetId, row.name);
      }
      if (portfolio.cash?.assetId) claimed.set(portfolio.cash.assetId, row.name);
      portfolioLinks.push({ candidate: portfolio, row });
      continue;
    }
    const candidate = row.twin?.candidates.find((item) => item.assetId === link.assetId);
    if (row.block !== null || !candidate) {
      return { error: `«${row.name}» no se puede enlazar con ese holding.`, ok: false };
    }
    const other = claimed.get(link.assetId);
    if (other !== undefined) {
      return {
        error: `«${candidate.name}» solo se puede enlazar con un producto: elige entre «${other}» y «${row.name}».`,
        ok: false,
      };
    }
    claimed.set(link.assetId, row.name);
    holdingLinks.push({ link, row });
  }
  // A traspaso is replaced whole or not at all (#1393): both its holdings link.
  for (const { link, row } of holdingLinks) {
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
      // A robo-advisor's fund or cash is included with its portfolio, never alone.
      const part = productByKey.get(key);
      if (part?.portfolioKey) {
        return {
          error: `«${part.name}» se incluye con su cartera gestionada, no por separado.`,
          ok: false,
        };
      }
      return gone;
    }
    if (row.linked) return { error: `«${row.name}» ya está incluido.`, ok: false };
    if (row.block !== null) {
      return { error: `«${row.name}» aún no se puede incluir.`, ok: false };
    }
  }

  const folded = foldMyInvestorOperations(discovery, input.sourceId).rows;
  const holdings: ConnectedHoldingCreation[] = [];
  const facts: NormalizedFact<CreateInvestmentOperationInput>[] = [];
  const factKeyById = new Map(
    discovery.operations.map((fact) => [
      myInvestorOperationId(input.sourceId, fact.key),
      fact.key,
    ]),
  );
  /** The product's operations, written into `assetId`. */
  const outIdByTransferId = new Map(
    [...folded.values()].flatMap((rows) =>
      rows.flatMap((row) =>
        row.kind === "transfer_out" && row.transferId
          ? [[row.transferId, row.id] as const]
          : [],
      ),
    ),
  );
  const soldOutIds = input.soldUnpairedOutIds ?? new Set<string>();
  const writeInto = (productKey: string, assetId: string) => {
    for (const operation of folded.get(productKey) ?? []) {
      const factKey = factKeyById.get(operation.id);
      if (factKey === undefined) continue;
      const payload = operationInput(operation, assetId);
      facts.push({
        dateKey: operation.executedAt.slice(0, 10),
        key: factKey,
        payload: entryOfSoldOrigin(
          payload,
          (transferId) => outIdByTransferId.get(transferId),
          soldOutIds,
        )
          ? pendingEntryOfSoldOrigin(payload)
          : payload,
      });
    }
  };
  /** Create one product as a holding of the source, with its history. */
  const create = (product: MyInvestorDiscoveredProduct): string | null => {
    const assetId = input.assetIdFor(product.key);
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
        productKey: product.key,
      });
      return assetId;
    }
    if (
      product.instrument === null ||
      product.kind === "managed" ||
      product.kind === "cash"
    ) {
      return null;
    }
    const instrument = KIND_INSTRUMENT[product.kind];
    const symbol = input.symbols.get(product.key) ?? null;
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
      productKey: product.key,
    });
    writeInto(product.key, assetId);
    return assetId;
  };

  const linkCommands: ConnectedHoldingLink[] = [];
  const cashLinks: ConnectedCashLink[] = [];
  for (const { link, row } of holdingLinks) {
    const product = productByKey.get(link.productKey)!;
    // A cash account kept by hand takes MyInvestor's balance: no operations move.
    if (row.twin?.reason === "cash" && product.cash !== null) {
      cashLinks.push({
        assetId: link.assetId,
        balanceMinor: toMinor(product.cash.balance),
        productKey: link.productKey,
      });
      continue;
    }
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
    writeInto(link.productKey, link.assetId);
  }

  const portfolios: ConnectedPortfolioCreation[] = [];
  const portfolioLinkCommands: ConnectedPortfolioLink[] = [];
  const witnessOf = (product: MyInvestorDiscoveredProduct) =>
    product.declared === null
      ? null
      : {
          declaredDate: discovery.readOn,
          declaredValue: {
            amountMinor: toMinor(product.declared.value),
            currency: product.declared.currency,
          },
        };
  // The portfolio is the scope's its holdings are: the connecting member's.
  const scopeId =
    input.ownership.length === 1 ? input.ownership[0]!.memberId : "household";

  for (const { candidate, row } of portfolioLinks) {
    const product = productByKey.get(row.key)!;
    const { cash } = myInvestorPortfolioParts(discovery, row.key);
    const added: string[] = [];
    for (const member of candidate.members) {
      if (member.assetId !== null) {
        linkCommands.push({ assetId: member.assetId, productKey: member.productKey });
        writeInto(member.productKey, member.assetId);
        continue;
      }
      const assetId = create(productByKey.get(member.productKey)!);
      if (assetId !== null) added.push(assetId);
    }
    if (cash !== null && cash.cash !== null && candidate.cash !== null) {
      if (candidate.cash.assetId !== null) {
        cashLinks.push({
          assetId: candidate.cash.assetId,
          balanceMinor: toMinor(cash.cash.balance),
          productKey: cash.key,
        });
      } else {
        const assetId = create(cash);
        if (assetId !== null) added.push(assetId);
      }
    }
    portfolioLinkCommands.push({
      addMemberAssetIds: added,
      portfolioId: candidate.portfolioId,
      productKey: row.key,
      witness: witnessOf(product),
    });
  }

  for (const key of keys) {
    const product = productByKey.get(key)!;
    if (product.kind === "managed") {
      // The parts the row offers: the whole block, or what is new in one linked.
      const block = rowByKey.get(key)!.portfolio!;
      const offered = [
        ...block.members.map((member) => member.key),
        ...(block.cash ? [block.cash.key] : []),
      ];
      const members = offered.flatMap(
        (partKey) => create(productByKey.get(partKey)!) ?? [],
      );
      if (block.joins !== null) {
        portfolioLinkCommands.push({
          addMemberAssetIds: members,
          portfolioId: block.joins.portfolioId,
          productKey: key,
          witness: witnessOf(product),
        });
        continue;
      }
      portfolios.push({
        memberAssetIds: members,
        name: product.name,
        productKey: key,
        provider: MYINVESTOR_PROVIDER,
        scopeId,
        witness: witnessOf(product),
      });
      continue;
    }
    if (create(product) === null) {
      return { error: `«${product.name}» aún no se puede incluir.`, ok: false };
    }
  }

  return {
    command: {
      ...(cashLinks.length > 0 ? { cashLinks } : {}),
      facts: { cursor: discovery.readOn, facts },
      holdings,
      links: linkCommands,
      ...(portfolioLinkCommands.length > 0
        ? { portfolioLinks: portfolioLinkCommands }
        : {}),
      ...(portfolios.length > 0 ? { portfolios } : {}),
      sourceId: input.sourceId,
      today: input.today,
    },
    ok: true,
  };
}

/** The manager a robo-advisor's portfolio is born with. */
const MYINVESTOR_PROVIDER = "MyInvestor";
