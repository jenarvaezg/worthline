/**
 * A robo-advisor's account as a managed portfolio (#1883, PRD #1876 S8; #1869 P5;
 * ADR 0085 as amended): pure.
 *
 * - **The block.** The account is ONE row of the fold: its funds — those the manager
 *   sold whole too, at 0 with their history, because the portfolio's return against
 *   the manager's needs them (#1552) — and its cash account, the cash sibling. The
 *   balance the manager declares is the witness, careed against the funds alone
 *   (#1550).
 * - **A portfolio kept by hand** is offered as the block's twin: a manual portfolio
 *   with a fund of the same ISIN. Linking it is all or nothing (#1883): each fund is
 *   paired with the member of its ISIN and gets the careo of #1881, the cash sibling
 *   takes MyInvestor's balance, the funds it lacked enter new — and a manual member
 *   MyInvestor does not have in this account BLOCKS the link, since leaving it would
 *   keep a hand-made row inside a group the source now writes.
 */
import type { InvestmentOperation } from "@worthline/domain";
import { myInvestorCareo } from "./myinvestor-careo";
import type {
  MyInvestorDiscoveredProduct,
  MyInvestorDiscovery,
} from "./myinvestor-discovery";
import {
  isPortfolioLinkable,
  type MyInvestorPortfolioCandidate,
  type MyInvestorPortfolioMemberCareo,
  type MyInvestorPortfolioTwin,
  type MyInvestorTwinChoice,
  myInvestorLinkChoice,
} from "./myinvestor-selection";
import type { MyInvestorTwinLedger } from "./myinvestor-twins";

/** A live member of a managed portfolio kept by hand, as the block's careo needs it. */
export interface MyInvestorManualPortfolioMember {
  readonly id: string;
  readonly name: string;
  /** `investment`, `cash` (the sibling) or anything else (the «sin detallar»). */
  readonly type: string;
  /** The ISIN it carries; null when none. */
  readonly code: string | null;
  /** Its value today: the cash sibling's «before». */
  readonly valueMinor: number;
}

/** A managed portfolio kept by hand: none of its members is a source's. */
export interface MyInvestorManualPortfolio {
  readonly id: string;
  readonly name: string;
  /** Its ficha, where a member is taken out; null without a public id. */
  readonly href: string | null;
  readonly members: readonly MyInvestorManualPortfolioMember[];
}

/** The products of a managed portfolio: its funds and its cash sibling. */
export function myInvestorPortfolioParts(
  discovery: MyInvestorDiscovery,
  portfolioKey: string,
): {
  funds: MyInvestorDiscoveredProduct[];
  cash: MyInvestorDiscoveredProduct | null;
} {
  const parts = discovery.products.filter(
    (product) => product.portfolioKey === portfolioKey,
  );
  return {
    cash: parts.find((product) => product.kind === "cash") ?? null,
    funds: parts.filter((product) => product.kind !== "cash"),
  };
}

/**
 * The portfolios kept by hand each robo-advisor block may be, by its key. Pure.
 * A candidate holds a fund with an ISIN of the block — the robo-advisor's funds
 * today or the ones its manager sold — the strong identifier of #1869 P3.
 */
export function findMyInvestorPortfolioTwins(
  discovery: MyInvestorDiscovery,
  input: {
    portfolios: readonly MyInvestorManualPortfolio[];
    linkedKeys: ReadonlySet<string>;
  },
): Map<string, MyInvestorManualPortfolio[]> {
  const twins = new Map<string, MyInvestorManualPortfolio[]>();
  for (const product of discovery.products) {
    if (product.kind !== "managed") continue;
    const { cash, funds } = myInvestorPortfolioParts(discovery, product.key);
    const parts = [...funds, ...(cash ? [cash] : [])];
    if (parts.some((part) => input.linkedKeys.has(part.key))) continue;
    const codes = new Set(funds.flatMap((fund) => fund.instrument?.code ?? []));
    const candidates = input.portfolios.filter((portfolio) =>
      portfolio.members.some(
        (member) =>
          member.type === "investment" && member.code !== null && codes.has(member.code),
      ),
    );
    if (candidates.length > 0) twins.set(product.key, candidates);
  }
  return twins;
}

/** A fund of the block with what the batch would write into it and what it is worth. */
export interface MyInvestorPortfolioFundRows {
  readonly product: MyInvestorDiscoveredProduct;
  readonly rows: readonly InvestmentOperation[];
  readonly valueMinor: number;
}

/**
 * The careo of the block against ONE portfolio kept by hand (#1883, design C per
 * member). The same rows the batch writes, the same careo as #1881.
 */
export function myInvestorPortfolioCandidate(input: {
  portfolio: MyInvestorManualPortfolio;
  funds: readonly MyInvestorPortfolioFundRows[];
  /** MyInvestor's cash account of the block and its balance; null when none. */
  cash: { readonly valueMinor: number } | null;
  ledgers: ReadonlyMap<string, MyInvestorTwinLedger>;
  today: string;
}): MyInvestorPortfolioCandidate {
  const { portfolio } = input;
  const investments = portfolio.members.filter((member) => member.type === "investment");
  const claimed = new Set<string>();
  const members: MyInvestorPortfolioMemberCareo[] = input.funds.map(
    ({ product, rows, valueMinor }) => {
      const code = product.instrument?.code ?? null;
      const manual = investments.find(
        (member) =>
          member.code !== null && member.code === code && !claimed.has(member.id),
      );
      if (!manual) {
        return {
          assetId: null,
          assetName: null,
          careo: null,
          enteringMinor: valueMinor,
          name: product.name,
          productKey: product.key,
        };
      }
      claimed.add(manual.id);
      const ledger = input.ledgers.get(manual.id);
      return {
        assetId: manual.id,
        assetName: manual.name,
        careo: myInvestorCareo({
          manual: ledger?.operations ?? [],
          plan: ledger?.plan ?? null,
          source: rows,
          today: input.today,
          ...(ledger?.cachedPrice ? { cachedPrice: ledger.cachedPrice } : {}),
          ...(ledger?.manualPrice ? { manualPrice: ledger.manualPrice } : {}),
        }),
        enteringMinor: 0,
        name: product.name,
        productKey: product.key,
      };
    },
  );

  // Every member that is neither paired with a fund nor the cash sibling blocks:
  // an unpaired fund (no ISIN, another ISIN, or a second one of the same) and the
  // «(sin detallar)» aggregate, which stands for funds MyInvestor now lists itself.
  const manualCash = portfolio.members.find((member) => member.type === "cash") ?? null;
  const blockers = portfolio.members
    .filter((member) => !claimed.has(member.id) && member !== manualCash)
    .map((member) => member.name);
  const paired = new Set([...claimed, ...(manualCash ? [manualCash.id] : [])]);
  const strandedTransfers = [
    ...new Set(
      [...claimed].flatMap((assetId) =>
        (input.ledgers.get(assetId)?.pairedWith ?? [])
          .filter((pair) => !paired.has(pair.assetId))
          .map((pair) => pair.name),
      ),
    ),
  ];

  // MyInvestor's cash replaces the manual sibling; with no sibling it enters new. A
  // sibling MyInvestor has no cash for stays as it is, manual, inside the group.
  const cash =
    input.cash === null
      ? null
      : {
          afterMinor: input.cash.valueMinor,
          assetId: manualCash?.id ?? null,
          beforeMinor: manualCash?.valueMinor ?? 0,
          name: manualCash?.name ?? "Efectivo de la cartera",
        };
  const valueDeltaMinor =
    members.reduce(
      (sum, member) => sum + (member.careo?.valueDeltaMinor ?? member.enteringMinor),
      0,
    ) + (cash ? cash.afterMinor - cash.beforeMinor : 0);

  return {
    blockers,
    cash,
    href: portfolio.href,
    members,
    name: portfolio.name,
    portfolioId: portfolio.id,
    strandedTransfers,
    valueDeltaMinor,
  };
}

/** The block's twin: its candidates, and «Enlazar» only for a lone, unblocked one. */
export function myInvestorPortfolioTwin(
  candidates: readonly MyInvestorPortfolioCandidate[],
  otherHolder: boolean,
): MyInvestorPortfolioTwin {
  const only = candidates.length === 1 ? candidates[0]! : null;
  const defaultChoice: MyInvestorTwinChoice =
    only !== null && isPortfolioLinkable(only) && !otherHolder
      ? myInvestorLinkChoice(only.portfolioId)
      : "skip";
  return { candidates, defaultChoice };
}
