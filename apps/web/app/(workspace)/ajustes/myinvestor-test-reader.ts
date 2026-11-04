/**
 * Test-only: a MyInvestor reader that is offline — every read answers the network
 * failure the client maps (#1877), so a connection test that has no use for the
 * first start's read (#1880) can hand one to its fake client and see the read fail
 * without anything reaching the relay.
 */
import type { MyInvestorReader } from "@worthline/pricing";

export function offlineMyInvestorReader(): MyInvestorReader {
  const down = async () => ({
    error: {
      attempts: 1,
      code: null,
      httpStatus: null,
      kind: "network_or_waf" as const,
      step: "positions" as const,
    },
    ok: false as const,
  });
  return {
    automaticContributions: down,
    brokerOrderDetail: down,
    brokerOrders: down,
    cashAccounts: down,
    pendingFundTransfers: down,
    pensionAccounts: down,
    pensionOrders: down,
    pensionPlans: down,
    pensionShareSeries: down,
    portfolios: down,
    securitiesAccount: down,
    securitiesAccounts: down,
    securitiesOrders: down,
    tokens: () => ({ accessToken: "offline", refreshToken: null }),
  };
}
