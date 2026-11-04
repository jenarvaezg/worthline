/**
 * The wire vocabulary MyInvestor's client and its relay share (#1877, ADR 0114): the
 * host, the routes the connector calls, the headers of the relay protocol and the POST
 * routes the relay lets through.
 *
 * It imports nothing on purpose: `apps/myinvestor-relay` reads it through the package
 * subpath `@worthline/pricing/myinvestor/protocol`, and the Worker must not carry the
 * rest of the package.
 */

export const MYINVESTOR_API_HOST = "api.myinvestor.es";
export const MYINVESTOR_API_ORIGIN = `https://${MYINVESTOR_API_HOST}`;

/** Headers of the relay protocol: the shared secret, the target URL, its own refusals. */
export const RELAY_SECRET_HEADER = "x-relay-secret";
export const RELAY_TARGET_HEADER = "x-relay-target";
export const RELAY_ERROR_HEADER = "x-relay-error";

/** The device that passed the SMS once, sent with every call. */
export const DEVICE_ID_HEADER = "x-device-id";
/** The signature request a login repeats once its SMS code is validated. */
export const SIGNATURE_ID_HEADER = "x-signature-id";

const CPERF = "/cperf-server/api";
const BROKER = "/broker/v2";
const SIGNATURE = "/signature/api/v3/public/signature";

/** An id as one path segment, so it cannot change the route. */
const segment = (id: string) => encodeURIComponent(id);

/** Every route the connector calls, absolute on {@link MYINVESTOR_API_HOST}. */
export const MYINVESTOR_PATHS = {
  login: "/login/api/v2/auth/token",
  refresh: "/login/api/v1/auth/token/refresh",
  /** Sends the code of a pending signature. */
  signatureCode: (requestId: string) => `${SIGNATURE}/${segment(requestId)}`,
  /** Validates the code the user typed. */
  signatureValidation: (requestId: string, signatureId: string) =>
    `${SIGNATURE}/${segment(requestId)}/validate/${segment(signatureId)}`,

  cashAccounts: `${CPERF}/v2/cash-accounts/self`,
  securitiesAccounts: `${CPERF}/v2/securities-accounts/self-basic`,
  securitiesAccount: (id: string) => `${CPERF}/v2/securities-accounts/${segment(id)}`,
  securitiesOrders: (id: string) =>
    `${CPERF}/v3/securities-accounts/${segment(id)}/orders`,
  securitiesPositions: (id: string) =>
    `${CPERF}/v2/securities-accounts/${segment(id)}/positions`,
  pendingTransfers: (id: string) =>
    `${CPERF}/v2/securities-accounts/${segment(id)}/transfers/pending`,
  brokerOrders: `${BROKER}/stock-orders`,
  brokerOrderDetail: (id: string) => `${BROKER}/stock-orders/${segment(id)}`,
  pensionAccounts: `${CPERF}/v2/pension-accounts/self`,
  pensionAccount: (id: string) => `${CPERF}/v2/pension-accounts/${segment(id)}`,
  pensionOrders: (id: string) => `${CPERF}/v2/pension-accounts/${segment(id)}/orders`,
  pensionPositions: (id: string) =>
    `${CPERF}/v2/pension-accounts/${segment(id)}/positions`,
  automaticContributions: `${CPERF}/v2/automatic-contributions/self`,
  portfolios: `${CPERF}/v2/portfolios`,
} as const;

/**
 * Whether a POST to this path is one the client makes: the login, the refresh, and the
 * two steps of the SMS signature. Everything else the connector does is a GET, so the
 * relay refuses any other POST (PRD #1876, invariant 1: it never writes at MyInvestor).
 */
export function isSignInPost(pathname: string): boolean {
  if (pathname === MYINVESTOR_PATHS.login || pathname === MYINVESTOR_PATHS.refresh) {
    return true;
  }
  if (!pathname.startsWith(`${SIGNATURE}/`)) return false;
  const [requestId, validate, signatureId, ...rest] = pathname
    .slice(SIGNATURE.length + 1)
    .split("/");
  if (!requestId || rest.length > 0) return false;
  if (validate === undefined) return true;
  return validate === "validate" && Boolean(signatureId);
}
