/**
 * The first start of MyInvestor, pure (#1880, PRD #1876 S5; #1869 P2, P3 and P4):
 * from what the discovery found to the fold that chooses what to include. Its
 * figures come from the SAME folded rows the batch writes
 * (`foldMyInvestorOperations`), so the fold can never promise a figure the book
 * will not hold (#1438).
 *
 * A product a live manual holding already is (#1881) is not created again unless
 * the user says so: it is LINKED, and the same folded rows replace the holding's
 * manual operations. Its careo comes from those rows too.
 */

import type { InvestmentOperation } from "@worthline/domain";
import { derivePosition, isPositiveDecimal } from "@worthline/domain";
import type { MyInvestorOperationFact } from "@worthline/pricing";
import { myInvestorCareo } from "./myinvestor-careo";
import {
  holdsSomethingToday,
  type MyInvestorDiscoveredProduct,
  type MyInvestorDiscovery,
  type MyInvestorProductKind,
} from "./myinvestor-discovery";
import {
  foldMyInvestorOperations,
  pendingInheritedCost,
  productKeyOf,
  toMinor,
} from "./myinvestor-operations-fold";
import {
  type MyInvestorManualPortfolio,
  myInvestorPortfolioCandidate,
  myInvestorPortfolioParts,
  myInvestorPortfolioTwin,
} from "./myinvestor-portfolio";
import {
  type MyInvestorFirstStartView,
  type MyInvestorInclusionBlock,
  type MyInvestorProductRow,
  type MyInvestorRung,
  type MyInvestorTwin,
  type MyInvestorTwinChoice,
  myInvestorLinkChoice,
} from "./myinvestor-selection";
import type { MyInvestorTwinLedger, MyInvestorTwinMatch } from "./myinvestor-twins";

const EUR = "EUR";

function rungOf(kind: MyInvestorProductKind): MyInvestorRung {
  if (kind === "cash") return "liquid";
  if (kind === "plan") return "retirement";
  return "invested";
}

/**
 * The fold that chooses what to include, by account as the bank shows them. Pure.
 *
 * `twins` are the manual holdings each product may be ({@link findMyInvestorTwins}),
 * and `ledgers` what was read of each of them, by holding id, for its careo;
 * `linkedKeys` are the products already linked. `portfolioTwins` are the portfolios
 * kept by hand each robo-advisor block may be ({@link findMyInvestorPortfolioTwins}),
 * whose members' ledgers are in `ledgers` too.
 *
 * A robo-advisor's account is ONE row (#1883): its funds and cash ride under it,
 * never as rows of their own.
 *
 * An order in another currency is written in euros at the ECB rate the read kept for
 * its day (#1899, ADR 0072); a product whose rate the read lacks is blocked until a
 * later read brings it. The include plan folds the same read, with the same rates.
 */
export function myInvestorFirstStartView(
  discovery: MyInvestorDiscovery,
  input: {
    sourceId: string;
    linkedKeys: ReadonlySet<string>;
    twins: ReadonlyMap<string, MyInvestorTwinMatch>;
    ledgers: ReadonlyMap<string, MyInvestorTwinLedger>;
    today: string;
    portfolioTwins?: ReadonlyMap<string, readonly MyInvestorManualPortfolio[]>;
    /**
     * The portfolio each robo-advisor block already linked lives in, by the block's
     * key: what it bought since joins it there (#1883).
     */
    connectedPortfolios?: ReadonlyMap<
      string,
      { readonly portfolioId: string; readonly name: string }
    >;
  },
): MyInvestorFirstStartView {
  const fold = foldMyInvestorOperations(discovery, input.sourceId);
  const folded = fold.rows;
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
      // A cash account has no operations to careo: linking replaces its balance.
      if (match.reason === "cash" && product.cash !== null) {
        return {
          assetId: holding.id,
          careo: null,
          cash: {
            afterMinor: toMinor(product.cash.balance),
            beforeMinor: holding.valueMinor ?? 0,
          },
          name: holding.name,
          pairedWith: [],
        };
      }
      const ledger = input.ledgers.get(holding.id);
      return {
        assetId: holding.id,
        cash: null,
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

  const valueOf = (product: MyInvestorDiscoveredProduct): number =>
    product.cash !== null
      ? toMinor(product.cash.balance)
      : derivePosition([...(folded.get(product.key) ?? [])], {
          assetId: product.key,
          currency: EUR,
        }).costBasis.amountMinor;
  /**
   * Why a product cannot be included yet, or null (#1401, #1899): an order in a
   * currency worthline cannot capture — its own, or one its traspasos depend on — or
   * a cash balance in another currency; before that, an order that waits for the ECB
   * rate of its day.
   */
  const blockOf = (
    product: MyInvestorDiscoveredProduct,
  ): MyInvestorInclusionBlock | null => {
    if (
      fold.uncapturable.has(product.key) ||
      (product.cash !== null && product.cash.currency !== EUR)
    ) {
      return { reason: "currency" };
    }
    return fold.missingRates.has(product.key) ? { reason: "rate_missing" } : null;
  };

  /** A robo-advisor's block (#1883): its funds, its cash, its witness and its twin. */
  const portfolioOf = (product: MyInvestorDiscoveredProduct) => {
    const all = myInvestorPortfolioParts(discovery, product.key);
    const allParts = [...all.funds, ...(all.cash ? [all.cash] : [])];
    const linkedParts = allParts.filter((part) => input.linkedKeys.has(part.key));
    // A block already linked whose manager bought a fund since: only what is new
    // is offered, and it joins the portfolio the block lives in (#1883).
    const joins =
      linkedParts.length > 0 && linkedParts.length < allParts.length
        ? (input.connectedPortfolios?.get(product.key) ?? null)
        : null;
    const isNew = (part: MyInvestorDiscoveredProduct) =>
      joins === null || !input.linkedKeys.has(part.key);
    const funds = all.funds.filter(isNew);
    const cash = all.cash && isNew(all.cash) ? all.cash : null;
    const parts = [...funds, ...(cash ? [cash] : [])];
    const fundRows = funds.map((fund) => ({
      product: fund,
      rows: folded.get(fund.key) ?? [],
      valueMinor: valueOf(fund),
    }));
    const block = {
      cash:
        cash === null
          ? null
          : {
              identifier: cash.identifier,
              key: cash.key,
              name: cash.name,
              valueMinor: valueOf(cash),
            },
      declaredMinor: product.declared ? toMinor(product.declared.value) : null,
      joins,
      // A loose manual holding carrying a fund's ISIN: including the block would
      // count that money twice, so the block says so and opens unticked.
      looseTwins: funds.flatMap((fund) => {
        const match = input.twins.get(fund.key);
        if (match?.reason !== "identifier") return [];
        return match.holdings.map((holding) => ({
          assetId: holding.id,
          fundName: fund.name,
          name: holding.name,
        }));
      }),
      members: fundRows.map(({ product: fund, rows, valueMinor }) => ({
        identifier: fund.identifier,
        key: fund.key,
        name: fund.name,
        operations: rows.length,
        soldByManager: fund.units === null || !isPositiveDecimal(fund.units),
        units: fund.units,
        valueMinor,
      })),
    };
    const candidates = (
      joins === null ? (input.portfolioTwins?.get(product.key) ?? []) : []
    ).map((portfolio) =>
      myInvestorPortfolioCandidate({
        cash: block.cash,
        funds: fundRows,
        ledgers: input.ledgers,
        portfolio,
        today: input.today,
      }),
    );
    const facts = funds.flatMap((fund) => factsByProduct.get(fund.key) ?? []);
    const rows = fundRows.flatMap((fund) => fund.rows);
    return {
      block,
      cashWithheld: cash?.cash?.withheld ?? null,
      inclusionBlock: blockOfParts(parts.map(blockOf)),
      linked: joins === null && linkedParts.length > 0,
      operations: rows.length,
      pending: facts.some(pendingInheritedCost),
      since:
        rows
          .map((row) => row.executedAt.slice(0, 10))
          .sort()
          .at(0) ?? null,
      twin:
        candidates.length === 0
          ? null
          : myInvestorPortfolioTwin(candidates, product.otherHolder),
      valueMinor:
        block.members.reduce((sum, member) => sum + member.valueMinor, 0) +
        (block.cash?.valueMinor ?? 0),
    };
  };

  const rowOf = (product: MyInvestorDiscoveredProduct): MyInvestorProductRow => {
    const managed = product.kind === "managed" ? portfolioOf(product) : null;
    const rows = folded.get(product.key) ?? [];
    const facts = factsByProduct.get(product.key) ?? [];
    const block = managed ? managed.inclusionBlock : blockOf(product);
    const linked = managed?.linked ?? input.linkedKeys.has(product.key);
    const twin =
      block === null && !linked && managed === null ? twinOf(product, rows) : null;
    const portfolioTwin = block === null && !linked ? (managed?.twin ?? null) : null;
    const withheld = managed ? managed.cashWithheld : (product.cash?.withheld ?? null);
    return {
      accountKey: product.accountKey,
      block,
      identifier: product.identifier,
      inheritedCostPending: managed?.pending ?? facts.some(pendingInheritedCost),
      key: product.key,
      kind: product.kind,
      linked,
      members: product.members,
      name: product.name,
      operations: managed?.operations ?? rows.length,
      otherHolder: product.otherHolder,
      portfolio: managed?.block ?? null,
      portfolioTwin,
      rung: rungOf(product.kind),
      selectedByDefault:
        !linked &&
        block === null &&
        twin === null &&
        portfolioTwin === null &&
        !product.otherHolder &&
        // A robo-advisor holds something when a fund has units or its cash a balance:
        // an emptied one is offered, never ticked.
        (managed
          ? managed.block.looseTwins.length === 0 &&
            (managed.valueMinor > 0 ||
              managed.block.members.some((member) => !member.soldByManager))
          : holdsSomethingToday(product)),
      since: managed ? managed.since : (rows[0]?.executedAt.slice(0, 10) ?? null),
      twin,
      units: product.units,
      valueMinor: managed?.valueMinor ?? valueOf(product),
      withheldMinor:
        withheld !== null && isPositiveDecimal(withheld) ? toMinor(withheld) : null,
    };
  };

  // A robo-advisor's funds and cash are not rows: they ride under their block. Save
  // when the block is linked and the portfolio it lived in was dissolved since:
  // what the manager bought later has nothing to join, so it is offered as a
  // product of its own, as the holdings already linked now are.
  const orphaned = new Set(
    discovery.products
      .filter((product) => product.kind === "managed")
      .flatMap((block) => {
        if (input.connectedPortfolios?.has(block.key)) return [];
        const { funds, cash } = myInvestorPortfolioParts(discovery, block.key);
        const parts = [...funds, ...(cash ? [cash] : [])];
        if (!parts.some((part) => input.linkedKeys.has(part.key))) return [];
        return parts
          .filter((part) => !input.linkedKeys.has(part.key))
          .map((part) => part.key);
      }),
  );
  const rows = settleTwinDefaults(
    discovery.products
      .filter((product) => !product.portfolioKey || orphaned.has(product.key))
      .map(rowOf),
  );
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
 * The block of a robo-advisor's account from its parts' (#1899): a currency it cannot
 * capture wins over a rate that is missing; null when nothing blocks.
 */
function blockOfParts(
  blocks: readonly (MyInvestorInclusionBlock | null)[],
): MyInvestorInclusionBlock | null {
  return (
    blocks.find((block) => block?.reason === "currency") ??
    blocks.find((block) => block !== null) ??
    null
  );
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
