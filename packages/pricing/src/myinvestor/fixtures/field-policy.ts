/**
 * What the anonymizer does with each field of a MyInvestor response (#1887).
 *
 * The table is closed on purpose: a key that is not here makes the anonymizer throw, so a
 * field the API adds later cannot reach a fixture without someone deciding what it is.
 * The leak check (`leak-check.ts`) reads the same table, and treats anything that is not
 * `public` as sensitive.
 *
 * - `amount`: money. Each distinct real amount becomes its own invented fake
 *   (`figure-map.ts`); the aggregates (positions, balances, invested, market values) are
 *   then RECALCULATED from the invented orders (`rebuild.ts`), so the fixture adds up.
 * - `quantity`: a number of shares. Invented the same way, then recalculated from the
 *   invented amounts and the real prices.
 * - `public`: enums, ISIN and DGS codes, tickers, fund names, operation dates, prices
 *   per share (a NAV is public) and returns in % (recalculated where they depend on the
 *   invented figures).
 * - every other rule replaces the value by its stable fake (`pseudonymizer.ts`).
 */

export type FieldRule =
  | "public"
  | "amount"
  | "quantity"
  | "id"
  | "reference"
  | "iban"
  | "uuid"
  | "document"
  | "person-name"
  | "alias"
  | "free-text"
  | "email"
  | "phone"
  | "personal-date";

const AMOUNTS = [
  "amount",
  "amountAccount",
  "amountToBlock",
  "balance",
  "balanceWithholdings",
  "cash",
  "cashAccountBalance",
  "currencyMarketValue",
  "enabledBalance",
  "fundsMarketValue",
  "fundsProfit",
  "fundsTotalInvested",
  "initialInvestment",
  "initialInvestmentCurrency",
  "investmentAddedValue",
  "marketValue",
  "profit",
  "stocksMarketValue",
  "stocksProfit",
  "stocksTotalInvested",
  "totalAmount",
  "totalInvested",
  "withheldBalance",
  // per-share cost: it comes from the holder's own flows, so it is recalculated too
  "averageCost",
  "avgPositionCost",
  // broker
  "grossAmount",
  "grossAmountCurrency",
  "grossAmountOperationCurrency",
  "netAmountAccountCurrency",
  "netAmountCurrency",
  "netAmountEUR",
  "otherCommissions",
  "tradeCommissions",
] as const;

const QUANTITIES = [
  "availableShares",
  "cancelShares",
  "execShares",
  "executedShares",
  "marketShares",
  "shares",
  "totalShares",
  "viewShares",
] as const;

const PUBLIC = [
  // envelope
  "status",
  "code",
  "timestamp",
  "payload",
  "data",
  // enums and flags
  "accountType",
  "accountTypeEnum",
  "active",
  "activeTypeCode",
  "brokerProductType",
  "cancellationStatus",
  "contributionType",
  "discontinued",
  "family",
  "firstSubscriptionType",
  "hasAddedValueErrors",
  "hasAddedValueFunds",
  "hasBrokerOperations",
  "hasCoOwner",
  "hasFundsOperations",
  "hasOperations",
  "haveSegoToken",
  "haveUrbanitaeToken",
  "investmentAmountReached",
  "investmentProductType",
  "isCancelable",
  "isCancellableOrder",
  "isCustomized",
  "isDeviceRequired",
  "isPeriodicOrder",
  "locale",
  "market",
  "marketCode",
  "me",
  "myInvestorCategory",
  "openingType",
  "operationType",
  "orderStatus",
  "orderType",
  "participantType",
  "productType",
  "productTypeCode",
  "recurrence",
  "referenceChangeEligible",
  "refundType",
  "retiree",
  "shouldDoContribution",
  "signStatus",
  "subscriptionType",
  "taxCountryCod",
  "toAccountType",
  "typeDocumentId",
  // instruments and catalog
  "category",
  "codBenchmark",
  "currency",
  "description",
  "dgsCode",
  "fundId",
  "fundName",
  "image",
  "idMorningstar",
  "infoFundUrl",
  "investmentName",
  "isin",
  "labelGraph",
  "liquidationValueCurrency",
  "minimumInvestment",
  "portfolioImage",
  "portfolioName",
  "portfolioProfileType",
  "profile",
  "recommended",
  "recommendedTimeHorizon",
  "reported",
  "stockId",
  "successiveSubsMinTax",
  "symbolGraph",
  "ticker",
  "type",
  "urlDataSheet",
  // broker orders: instrument, enums and descriptions
  "instrumentCurrency",
  "instrumentIsin",
  "instrumentMarket",
  "instrumentName",
  "length",
  "marketDescription",
  "marketId",
  "mifidResult",
  "operation",
  "operationDescription",
  "operationOrders",
  "orderClassDescription",
  "orderClassId",
  "orderOperationType",
  "orderOperationTypeEnum",
  "orderTypeDescription",
  "orderTypeId",
  "periodicityDescription",
  "periodicityType",
  "restrictionTypeDescription",
  "resultTargetMarketDescription",
  "serviceTypeDescription",
  "swMeetTargetMarket",
  "toolName",
  // operation and series dates
  "cancelDate",
  "executionDate",
  "finishDate",
  "firstOrderDate",
  "limitDate",
  "validityEndDate",
  "validityStartDate",
  "creationDate",
  "date",
  "effectiveDate",
  "endDate",
  "expirationDate",
  "liquidationValueDate",
  "nextExecutionDate",
  "orderDate",
  "profitabilityFrom",
  "profitabilityTo",
  "returnUpdateDate",
  "startDate",
  // per-share figures and ratios, independent of the size of the holding
  "addedValueReturn",
  "amountBuyVL",
  "exchangeRate",
  "fifthYearFundReturn",
  "firstYearFundReturn",
  "firstYearReturn",
  "fixedIncome",
  "fundsAddedValueReturn",
  "fundsTotalReturn",
  "limitPrice",
  "liquidationValue",
  "originCurrencyLiquidationValue",
  "percentage",
  "price",
  "priceCurrency",
  "profitability",
  "profitabilityGains",
  "profitabilityYTD",
  "returnValue",
  "stocksAddedValueReturn",
  "stocksTotalReturn",
  "thirdYearFundReturn",
  "thirdYearReturn",
  "totalReturn",
  "variableIncome",
  "yearFive",
  "yearOne",
  "yearThree",
  "ytd",
  "ytdFundReturn",
  "ytdTotalReturn",
  // counts
  "pendingTransfers",
  "plansNumber",
  "productNum",
  "valuePlansNumber",
  // containers and always-null placeholders
  "cashActives",
  "contributionTimeFrame",
  "funds",
  "gains",
  "holders",
  "investmentGains",
  "investmentList",
  "investmentProfitability",
  "minFirstSubscription",
  "minNextSubscriptions",
  "obligationActives",
  "otherActives",
  "positions",
  "securitiesAccountInvestments",
  "stockActives",
  "typeBalancePositions",
  "addedValueAmount",
  "addedValueInvestmentAmount",
  "fundsAddedValueInvestmentAmount",
  "stocksAddedValueInvestmentAmount",
] as const;

const PSEUDONYMIZED: Record<string, FieldRule> = {
  accountCode: "id",
  accountExternalCode: "id",
  accountId: "id",
  accountPensionId: "id",
  cashAccountId: "id",
  codAccount: "id",
  contributionId: "id",
  externalAccountCode: "id",
  externalCodAccount: "id",
  fromAccountId: "id",
  pensionAccountId: "id",
  rentId: "id",
  securitiesAccountId: "id",
  stockAccountId: "id",
  accountNumber: "id",
  toAccountId: "id",
  orderRef: "reference",
  reference: "reference",
  orderReference: "reference",
  paymentAccount: "iban",
  fromAccountIban: "iban",
  iban: "iban",
  onBoardingAccount: "iban",
  toAccountIban: "iban",
  accountUuid: "uuid",
  userId: "uuid",
  coreUsername: "document",
  documentId: "document",
  documentNumber: "document",
  firstSurname: "person-name",
  secondSurname: "person-name",
  surname1: "person-name",
  surname2: "person-name",
  ordererCustomer: "person-name",
  alias: "alias",
  fromAccountAlias: "alias",
  toAccountAlias: "alias",
  message: "free-text",
  externalId: "free-text",
  externalProposal: "free-text",
  observations: "free-text",
  proposal: "free-text",
  userCancel: "free-text",
  userOrder: "free-text",
  email: "email",
  phone: "phone",
  phonePrefix: "public",
  birthDate: "personal-date",
  documentExpirationDate: "personal-date",
};

const RULES = new Map<string, FieldRule>([
  ...AMOUNTS.map((key) => [key, "amount"] as const),
  ...QUANTITIES.map((key) => [key, "quantity"] as const),
  ...PUBLIC.map((key) => [key, "public"] as const),
  ...Object.entries(PSEUDONYMIZED),
]);

/**
 * Objects whose keys are data, not field names: the keys must match the pattern and the
 * values are walked with the table as usual.
 */
export const MAP_CONTAINERS: Readonly<Record<string, RegExp>> = {
  positions: /^(?:[A-Z]{2}[A-Z0-9]{9}\d|N\d{4})$/,
  securitiesAccountInvestments: /^[A-Z][A-Z_]*$/,
};

/**
 * The rule for `key` inside `parent`, or `undefined` when nobody has classified it. Three
 * keys depend on their object: `name` is a person only next to a surname (elsewhere it is
 * a fund or a plan); `id` is a person's uuid, a broker order's reference when it is
 * digits, and a catalog id (a roboadvisor portfolio) when it is a number; and `amount` is
 * the catalog's minimum subscription next to `firstSubscriptionType`.
 */
export function ruleFor(
  key: string,
  parent: Readonly<Record<string, unknown>>,
): FieldRule | undefined {
  if (key === "name") {
    return "surname1" in parent || "firstSurname" in parent ? "person-name" : "public";
  }
  if (key === "id") {
    if (typeof parent.id !== "string") return "public";
    return /^\d+$/.test(parent.id) ? "reference" : "uuid";
  }
  if (key === "amount" && "firstSubscriptionType" in parent) return "public";
  return RULES.get(key);
}
