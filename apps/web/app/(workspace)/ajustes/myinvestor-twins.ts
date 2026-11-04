/**
 * The manual twins of MyInvestor's products (#1881, PRD #1876 S6; #1869 P3): which
 * live manual holdings a product may already be, before their ledgers are read,
 * and what the careo of each candidate needs of them.
 */
import type { HoldingContributionPlan } from "@worthline/db";
import type { DecimalString, InvestmentOperation } from "@worthline/domain";
import { myInvestorNamesAlike } from "./myinvestor-careo";
import type { MyInvestorDiscovery } from "./myinvestor-discovery";
import type { MyInvestorTwin } from "./myinvestor-selection";

/** A live MANUAL investment, as the twin search needs it (#1881). */
export interface MyInvestorManualHolding {
  readonly id: string;
  readonly name: string;
  /** The ISIN or DGS code it carries; null when it carries none. */
  readonly code: string | null;
  /** A cash account's balance today, its «before» when linked; absent otherwise. */
  readonly valueMinor?: number;
}

/** A live MANUAL cash account outside any managed portfolio, for the cash twin. */
export interface MyInvestorManualCash {
  readonly id: string;
  readonly name: string;
  readonly valueMinor: number;
}

/** Which manual holdings a product may be, before their ledgers are read. */
export interface MyInvestorTwinMatch {
  readonly reason: MyInvestorTwin["reason"];
  readonly scheme: MyInvestorTwin["scheme"];
  readonly holdings: readonly MyInvestorManualHolding[];
}

/** «MyInvestor» or «My Investor» in a name, however it is written. */
const SAYS_MYINVESTOR = /my\s*investor/i;

/**
 * The manual twins of each product not linked yet (#1881, #1869 P3). Pure.
 *
 * - **Strong**: a holding that carries the product's ISIN or DGS code. A manual
 *   holding has no account, so the code is all there is to compare.
 * - **Suggestion**: only when there is no strong one, a holding that carries no
 *   identifier and whose name is alike. It is never ticked.
 * - **Cash**: worthline keeps no IBAN for a cash account, so MyInvestor's cash
 *   account can only SUGGEST a manual one whose name says MyInvestor or is alike
 *   (ADR 0115, amendment of 2026-11-04). It is never ticked; linking it replaces
 *   the balance, never operations.
 *
 * A managed portfolio has no units to compare: it never has a twin of its own.
 */
export function findMyInvestorTwins(
  discovery: MyInvestorDiscovery,
  input: {
    manual: readonly MyInvestorManualHolding[];
    /** The live manual cash accounts outside any portfolio; none when absent. */
    cash?: readonly MyInvestorManualCash[];
    linkedKeys: ReadonlySet<string>;
  },
): Map<string, MyInvestorTwinMatch> {
  const twins = new Map<string, MyInvestorTwinMatch>();
  for (const product of discovery.products) {
    if (input.linkedKeys.has(product.key)) continue;
    // A robo-advisor's cash is its portfolio's sibling, linked with the block.
    if (product.kind === "cash" && product.cash !== null && !product.portfolioKey) {
      const alike = (input.cash ?? []).filter(
        (account) =>
          SAYS_MYINVESTOR.test(account.name) ||
          myInvestorNamesAlike(product.name, account.name),
      );
      if (alike.length > 0) {
        twins.set(product.key, {
          holdings: alike.map((account) => ({ ...account, code: null })),
          reason: "cash",
          scheme: null,
        });
      }
      continue;
    }
    if (product.instrument === null) continue;
    const { code, scheme } = product.instrument;
    const strong = input.manual.filter((holding) => holding.code === code);
    if (strong.length > 0) {
      twins.set(product.key, { holdings: strong, reason: "identifier", scheme });
      continue;
    }
    // A robo-advisor's fund is careed with its portfolio, as a block (#1883). Only
    // the identifier is kept for it: a loose holding of the same ISIN is money the
    // block would count twice; a name alike proves nothing.
    if (product.portfolioKey) continue;
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
