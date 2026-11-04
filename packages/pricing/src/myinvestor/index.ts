/**
 * The MyInvestor connector's client (#1877, PRD #1876): sign-in with the two-step
 * SMS, the read-only reads, all of it through the Cloudflare relay, and the error
 * map of ADR 0114. The sync and the ingestion adapter consume it from here.
 */
export {
  createMyInvestorClient,
  type MyInvestorClient,
  type MyInvestorClientOptions,
} from "./client";
export type {
  MyInvestorError,
  MyInvestorErrorKind,
  MyInvestorResult,
  MyInvestorStep,
} from "./errors";
export { DEFAULT_RETRY_DELAYS_MS } from "./exchange";
export {
  createMyInvestorAdapter,
  MYINVESTOR_ADAPTER_ID,
  MYINVESTOR_CURSOR_OVERLAP_DAYS,
  MYINVESTOR_HISTORY_ORIGIN,
  type MyInvestorAdapterOptions,
  MyInvestorSyncError,
  myInvestorAccountId,
} from "./ingest/adapter";
export type {
  MyInvestorCashBalanceFact,
  MyInvestorFact,
  MyInvestorFactPayload,
  MyInvestorInstrument,
  MyInvestorOperationFact,
  MyInvestorPositionFact,
  MyInvestorProduct,
  MyInvestorSkippedOrder,
  MyInvestorSkipReason,
  MyInvestorTransferLeg,
  MyInvestorUnpairedReason,
} from "./ingest/facts";
export {
  isMyInvestorExternalEntry,
  isMyInvestorUnpairedLeg,
  MYINVESTOR_EXTERNAL_TRANSFER_PREFIX,
  MYINVESTOR_UNPAIRED_TRANSFER_PREFIX,
} from "./ingest/facts";
export {
  holdingKey as myInvestorHoldingKey,
  type MyInvestorAccountOrders,
  type MyInvestorBrokerExecution,
  type MyInvestorOrderBook,
  normalizeMyInvestorOrders,
} from "./ingest/normalize";
export type {
  IsoDate,
  MyInvestorBrokerOrder,
  MyInvestorBrokerOrderDetail,
  MyInvestorCashAccount,
  MyInvestorContribution,
  MyInvestorContributionTimeFrame,
  MyInvestorHolder,
  MyInvestorOrder,
  MyInvestorOwnership,
  MyInvestorPensionAccount,
  MyInvestorPensionPlan,
  MyInvestorPortfolio,
  MyInvestorPortfolioFund,
  MyInvestorPosition,
  MyInvestorSecuritiesAccount,
  MyInvestorSecuritiesAccountSummary,
  MyInvestorSharePoint,
  MyInvestorShareSeries,
} from "./models";
export type { DateRange, MyInvestorReader } from "./reader";
export {
  MYINVESTOR_RELAY_MIN_SECRET_LENGTH,
  MYINVESTOR_RELAY_SECRET_ENV,
  MYINVESTOR_RELAY_URL_ENV,
  type MyInvestorRelayConfig,
  readMyInvestorRelayConfig,
  requireMyInvestorRelayConfig,
} from "./relay-config";
export type {
  CodeSent,
  CodeSubmission,
  LoginOutcome,
  MyInvestorCredentials,
  MyInvestorTokens,
  SignatureChallenge,
} from "./session";
export {
  createRelayTransport,
  type MyInvestorRequest,
  type MyInvestorTransport,
  type RelayTransportOptions,
  type TransportOutcome,
} from "./transport";
