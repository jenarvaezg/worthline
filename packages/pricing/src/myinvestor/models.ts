/**
 * The MyInvestor responses the connector reads, validated at the boundary (#1877).
 *
 * - Amounts and shares are `DecimalString`, built from the literal the API wrote
 *   (`json.ts`): no money or share count ever passes through a `number`.
 * - Dates are calendar days (`AAAA-MM-DD`): MyInvestor sends midnight timestamps
 *   (`2025-06-16T00:00:00.000+0000`) for funds and bare days for plans.
 * - Unknown fields are dropped, so a holder's name, document number, IBAN or the
 *   orderer of a broker order never reach worthline.
 * - MyInvestor's own valuations (market value, «invertido», profit) are not read:
 *   worthline prices and costs everything itself (PRD #1876, invariants 2 and 3).
 *
 * Field names follow the API, so a reader can follow a value back to the fixture.
 */
import { type DecimalString, normalizeDecimal } from "@worthline/domain";
import { z } from "zod";

import { JsonNumber } from "./json";

/** A calendar day, `AAAA-MM-DD`. */
export type IsoDate = string;

const jsonNumber = z.instanceof(JsonNumber);
const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

const decimal: z.ZodType<DecimalString, unknown> = z.union([
  jsonNumber.transform((value) => normalizeDecimal(value.source)),
  z.string().regex(DECIMAL_TEXT).transform(normalizeDecimal),
]);
const optionalDecimal = decimal.nullish().transform((value) => value ?? null);

/** Ids come as text or as numbers (`accountPensionId`); both end as text. */
const id: z.ZodType<string, unknown> = z.union([
  z.string().min(1),
  jsonNumber.transform((value) => value.source),
]);
const optionalId = id.nullish().transform((value) => value ?? null);

const text = z
  .string()
  .nullish()
  .transform((value) => value ?? null);
const flag = z
  .boolean()
  .nullish()
  .transform((value) => value ?? null);
const count = jsonNumber
  .transform((value) => Number(value.source))
  .pipe(z.number().int().nonnegative());

const day: z.ZodType<IsoDate, unknown> = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/)
  .transform((value) => value.slice(0, 10));
/** Some endpoints send `""` for a missing day. */
const optionalDay = z
  .union([day, z.literal("")])
  .nullish()
  .transform((value) => (value ? value : null));

/** The scheduled contributions spell the euro `€`. */
const currency = z
  .string()
  .nullish()
  .transform((value) => (value === "€" || !value ? "EUR" : value));

export type MyInvestorOwnership = "me" | "junior" | "other";

export interface MyInvestorHolder {
  readonly me: boolean;
  readonly participantType: string | null;
}

const holder = z.object({ me: z.boolean().default(false), participantType: text });

/** Whose an account is, as `myinvestor-cli` reads it: a minor's account has a JUNIOR holder. */
function ownershipOf(holders: readonly MyInvestorHolder[]): MyInvestorOwnership {
  if (holders.some((h) => h.participantType === "JUNIOR")) return "junior";
  if (holders.some((h) => h.me && h.participantType === "OWNER")) return "me";
  return "other";
}

export interface MyInvestorCashAccount {
  readonly accountId: string;
  readonly accountUuid: string | null;
  readonly alias: string | null;
  readonly accountType: string | null;
  readonly status: string | null;
  readonly currency: string;
  /** Available balance. */
  readonly enabledBalance: DecimalString;
  /** Held for orders in progress: their `amountToBlock` (PRD #1876, invariant 4). */
  readonly withheldBalance: DecimalString;
  readonly holders: readonly MyInvestorHolder[];
  readonly ownership: MyInvestorOwnership;
}

export const cashAccountsSchema: z.ZodType<MyInvestorCashAccount[], unknown> = z.array(
  z
    .object({
      accountId: id,
      accountUuid: text,
      alias: text,
      accountType: text,
      status: text,
      currency,
      enabledBalance: decimal,
      withheldBalance: decimal,
      holders: z.array(holder).default([]),
    })
    .transform((account) => ({ ...account, ownership: ownershipOf(account.holders) })),
);

export interface MyInvestorSecuritiesAccountSummary {
  readonly accountId: string;
  readonly cashAccountId: string | null;
  /** `SECURITIES_ACCOUNT`, or `SECURITIES_PORTFOLIO` for the robo-advisor. */
  readonly accountType: string | null;
  readonly status: string | null;
  readonly hasFundsOperations: boolean | null;
  readonly hasBrokerOperations: boolean | null;
}

export const securitiesAccountsSchema: z.ZodType<
  MyInvestorSecuritiesAccountSummary[],
  unknown
> = z.array(
  z.object({
    accountId: id,
    cashAccountId: optionalId,
    accountType: text,
    status: text,
    hasFundsOperations: flag,
    hasBrokerOperations: flag,
  }),
);

export interface MyInvestorPosition {
  /** The group it came in: `INDEXED_FUND`, `BROKER`… */
  readonly productType: string | null;
  /** On broker positions: `ETF`, `RV`… */
  readonly brokerProductType: string | null;
  readonly isin: string | null;
  readonly ticker: string | null;
  readonly name: string | null;
  readonly shares: DecimalString;
  readonly availableShares: DecimalString | null;
  readonly currency: string | null;
  readonly status: string | null;
}

const position = z
  .object({
    investmentProductType: text,
    brokerProductType: text,
    isin: text,
    ticker: text,
    investmentName: text,
    shares: decimal,
    availableShares: optionalDecimal,
    liquidationValueCurrency: text,
    status: text,
  })
  .transform(
    (raw): MyInvestorPosition => ({
      productType: raw.investmentProductType,
      brokerProductType: raw.brokerProductType,
      isin: raw.isin,
      ticker: raw.ticker,
      name: raw.investmentName,
      shares: raw.shares,
      availableShares: raw.availableShares,
      currency: raw.liquidationValueCurrency,
      status: raw.status,
    }),
  );

export interface MyInvestorSecuritiesAccount {
  readonly accountId: string;
  readonly cashAccountId: string | null;
  readonly accountType: string | null;
  readonly status: string | null;
  /** Robo-advisor accounts: the catalog portfolio and its risk profile. */
  readonly portfolioName: string | null;
  readonly portfolioProfileType: string | null;
  /** Today's positions, every group flattened (funds first, as the API sends them). */
  readonly positions: readonly MyInvestorPosition[];
}

export const securitiesAccountSchema: z.ZodType<MyInvestorSecuritiesAccount, unknown> = z
  .object({
    accountId: id,
    cashAccountId: optionalId,
    accountType: text,
    status: text,
    portfolioName: text,
    portfolioProfileType: text,
    securitiesAccountInvestments: z
      .record(z.string(), z.object({ investmentList: z.array(position).nullish() }))
      .nullish(),
  })
  .transform(({ securitiesAccountInvestments, ...account }) => ({
    ...account,
    positions: Object.values(securitiesAccountInvestments ?? {}).flatMap(
      (group) => group.investmentList ?? [],
    ),
  }));

export interface MyInvestorOrder {
  readonly reference: string;
  /** The securities or pension account. */
  readonly accountId: string | null;
  readonly orderDate: IsoDate;
  /** Funds. */
  readonly isin: string | null;
  /** Plans: the DGS code (`N####`). */
  readonly dgsCode: string | null;
  readonly ticker: string | null;
  readonly fundName: string | null;
  /** `INVESTMENT_FUNDS_SUBSCRIPTION`, `PLAN_CONTRIBUTION`, `IIC_SWITCH_REGISTRATION`… */
  readonly operationType: string | null;
  readonly orderType: string | null;
  /** `COMPLETE`, `IN_PROGRESS`, `REJECTED`… */
  readonly status: string | null;
  readonly cash: DecimalString | null;
  readonly shares: DecimalString | null;
  /** The NAV it executed at (`amountBuyVL`); null until executed. */
  readonly executionNav: DecimalString | null;
  readonly amountToBlock: DecimalString | null;
  readonly currency: string;
  readonly productType: string | null;
  readonly market: string | null;
  /** Plans; not a settlement date. */
  readonly effectiveDate: IsoDate | null;
  /** Funds; not a settlement date. */
  readonly expirationDate: IsoDate | null;
}

export const ordersSchema: z.ZodType<MyInvestorOrder[], unknown> = z.array(
  z
    .object({
      reference: id,
      securitiesAccountId: optionalId,
      pensionAccountId: optionalId,
      orderDate: day,
      isin: text,
      dgsCode: text,
      ticker: text,
      fundName: text,
      operationType: text,
      orderType: text,
      status: text,
      cash: optionalDecimal,
      shares: optionalDecimal,
      amountBuyVL: optionalDecimal,
      amountToBlock: optionalDecimal,
      currency,
      productType: text,
      market: text,
      effectiveDate: optionalDay,
      expirationDate: optionalDay,
    })
    .transform(
      ({
        securitiesAccountId,
        pensionAccountId,
        amountBuyVL,
        ...order
      }): MyInvestorOrder => ({
        ...order,
        accountId: securitiesAccountId ?? pensionAccountId,
        executionNav: amountBuyVL,
      }),
    ),
);

export interface MyInvestorBrokerOrder {
  /** The detail's `orderReference`. */
  readonly id: string;
  readonly orderDate: IsoDate | null;
  readonly status: string | null;
  readonly toolName: string | null;
  readonly ticker: string | null;
  /** A code such as `COMPRARVCONTADO`; the side is in the detail. */
  readonly operation: string | null;
  readonly shares: DecimalString | null;
  readonly amount: DecimalString | null;
  readonly currency: string;
}

export const brokerOrdersSchema: z.ZodType<MyInvestorBrokerOrder[], unknown> = z.array(
  z.object({
    id,
    orderDate: optionalDay,
    status: text,
    toolName: text,
    ticker: text,
    operation: text,
    shares: optionalDecimal,
    amount: optionalDecimal,
    currency,
  }),
);

export interface MyInvestorBrokerOrderDetail {
  readonly orderReference: string;
  readonly orderStatus: string | null;
  /** `BUY` or `SELL` (`orderOperationTypeEnum`). */
  readonly side: string | null;
  readonly orderDate: IsoDate | null;
  /** The UTC day of the execution timestamp. */
  readonly executionDate: IsoDate | null;
  readonly instrumentIsin: string | null;
  readonly instrumentName: string | null;
  readonly instrumentCurrency: string | null;
  /** The cash account's currency. */
  readonly currency: string;
  readonly shares: DecimalString | null;
  readonly executedShares: DecimalString | null;
  /** Execution price, in the instrument's currency. */
  readonly priceCurrency: DecimalString | null;
  readonly grossAmountOperationCurrency: DecimalString | null;
  readonly netAmountCurrency: DecimalString | null;
  /** The net charged or paid in the cash account. */
  readonly netAmountAccountCurrency: DecimalString | null;
  readonly netAmountEur: DecimalString | null;
  readonly tradeCommissions: DecimalString | null;
  readonly otherCommissions: DecimalString | null;
  readonly exchangeRate: DecimalString | null;
}

export const brokerOrderDetailSchema: z.ZodType<MyInvestorBrokerOrderDetail, unknown> = z
  .object({
    orderReference: id,
    orderStatus: text,
    orderOperationTypeEnum: text,
    orderDate: optionalDay,
    executionDate: optionalDay,
    instrumentIsin: text,
    instrumentName: text,
    instrumentCurrency: text,
    currency,
    shares: optionalDecimal,
    executedShares: optionalDecimal,
    priceCurrency: optionalDecimal,
    grossAmountOperationCurrency: optionalDecimal,
    netAmountCurrency: optionalDecimal,
    netAmountAccountCurrency: optionalDecimal,
    netAmountEUR: optionalDecimal,
    tradeCommissions: optionalDecimal,
    otherCommissions: optionalDecimal,
    exchangeRate: optionalDecimal,
  })
  .transform(
    ({
      orderOperationTypeEnum,
      netAmountEUR,
      ...detail
    }): MyInvestorBrokerOrderDetail => ({
      ...detail,
      side: orderOperationTypeEnum,
      netAmountEur: netAmountEUR,
    }),
  );

export const pendingTransfersSchema: z.ZodType<number, unknown> = z
  .object({ pendingTransfers: count })
  .transform((value) => value.pendingTransfers);

export interface MyInvestorPensionAccount {
  readonly accountId: string;
  readonly cashAccountId: string | null;
  readonly active: boolean | null;
  readonly plansNumber: number | null;
  readonly holders: readonly MyInvestorHolder[];
  readonly ownership: MyInvestorOwnership;
}

export const pensionAccountsSchema: z.ZodType<MyInvestorPensionAccount[], unknown> =
  z.array(
    z
      .object({
        accountId: id,
        cashAccountId: optionalId,
        active: flag,
        plansNumber: count.nullish().transform((value) => value ?? null),
        holders: z.array(holder).default([]),
      })
      .transform((account) => ({ ...account, ownership: ownershipOf(account.holders) })),
  );

export interface MyInvestorPensionPlan {
  readonly accountPensionId: string | null;
  readonly dgsCode: string;
  readonly name: string | null;
  readonly shares: DecimalString;
  readonly currency: string;
  readonly status: string | null;
}

export const pensionPlansSchema: z.ZodType<MyInvestorPensionPlan[], unknown> = z.array(
  z.object({
    accountPensionId: optionalId,
    dgsCode: z.string().min(1),
    name: text,
    shares: decimal,
    currency,
    status: text,
  }),
);

export interface MyInvestorSharePoint {
  readonly date: IsoDate;
  readonly totalShares: DecimalString;
}

/** The `SINCE_BEGINNING` series of a pension account, per DGS code, oldest first. */
export type MyInvestorShareSeries = Readonly<
  Record<string, readonly MyInvestorSharePoint[]>
>;

export const shareSeriesSchema: z.ZodType<MyInvestorShareSeries, unknown> = z
  .object({
    positions: z
      .record(z.string(), z.array(z.object({ date: day, totalShares: decimal })))
      .nullish(),
  })
  .transform(({ positions }) =>
    Object.fromEntries(
      Object.entries(positions ?? {}).map(([code, points]) => [
        code,
        [...points].sort((left, right) => left.date.localeCompare(right.date)),
      ]),
    ),
  );

export interface MyInvestorContributionTimeFrame {
  /** `ONE_MONTH`… */
  readonly recurrence: string | null;
  readonly startDate: IsoDate | null;
  readonly endDate: IsoDate | null;
  readonly nextExecutionDate: IsoDate | null;
}

export interface MyInvestorContribution {
  readonly contributionId: string;
  /** `ACTIVE`, `CANCELED`… */
  readonly status: string | null;
  readonly amount: DecimalString;
  readonly currency: string;
  /** What it buys: the fund's ISIN, or the plan's DGS code (the API calls both `isin`). */
  readonly productCode: string | null;
  readonly fundName: string | null;
  readonly contributionType: string | null;
  readonly subscriptionType: string | null;
  /** `SECURITIES_ACCOUNT` or `PENSION_PLAN`. */
  readonly toAccountType: string | null;
  readonly toAccountId: string | null;
  /** The cash account it is charged to. */
  readonly fromAccountId: string | null;
  readonly timeFrame: MyInvestorContributionTimeFrame | null;
}

export const contributionsSchema: z.ZodType<MyInvestorContribution[], unknown> = z.array(
  z
    .object({
      contributionId: id,
      status: text,
      amount: decimal,
      currency,
      isin: text,
      fundName: text,
      contributionType: text,
      subscriptionType: text,
      toAccountType: text,
      toAccountId: optionalId,
      fromAccountId: optionalId,
      contributionTimeFrame: z
        .object({
          recurrence: text,
          startDate: optionalDay,
          endDate: optionalDay,
          nextExecutionDate: optionalDay,
        })
        .nullish()
        .transform((value) => value ?? null),
    })
    .transform(
      ({ isin, contributionTimeFrame, ...contribution }): MyInvestorContribution => ({
        ...contribution,
        productCode: isin,
        timeFrame: contributionTimeFrame,
      }),
    ),
);

export interface MyInvestorPortfolioFund {
  readonly isin: string;
  readonly name: string | null;
  /** The target weight, in percent. */
  readonly percentage: DecimalString | null;
  readonly category: string | null;
}

export interface MyInvestorPortfolio {
  readonly id: string;
  readonly name: string | null;
  readonly profile: string | null;
  readonly type: string | null;
  readonly funds: readonly MyInvestorPortfolioFund[];
}

/** The robo-advisor catalog: each portfolio with its target funds and weights. */
export const portfoliosSchema: z.ZodType<MyInvestorPortfolio[], unknown> = z.array(
  z.object({
    id,
    name: text,
    profile: text,
    type: text,
    funds: z
      .array(
        z.object({
          isin: z.string().min(1),
          name: text,
          percentage: optionalDecimal,
          category: text,
        }),
      )
      .nullish()
      .transform((value) => value ?? []),
  }),
);
