import type { MyInvestorError, MyInvestorReader } from "@worthline/pricing";
import { describe, expect, test, vi } from "vitest";
import { logMyInvestorFailure } from "./myinvestor-failure-log";
import {
  MYINVESTOR_READ_FAILED,
  storeMyInvestorDiscovery,
} from "./myinvestor-first-start-flow";

const SERVER_ERROR: MyInvestorError = {
  attempts: 4,
  code: "server_error",
  httpStatus: 502,
  kind: "network_or_waf",
  step: "orders",
};

describe("a failed MyInvestor call reaches the server log (#1876)", () => {
  test("only the typed error goes out", () => {
    const log = vi.fn();
    logMyInvestorFailure("reading the products", SERVER_ERROR, log);
    expect(log).toHaveBeenCalledWith("[myinvestor] reading the products failed", {
      attempts: 4,
      code: "server_error",
      httpStatus: 502,
      kind: "network_or_waf",
      step: "orders",
    });
  });

  test("a read that fails says so to the user and logs which call failed", async () => {
    const reader = {
      cashAccounts: async () => ({ error: SERVER_ERROR, ok: false }),
    } as unknown as MyInvestorReader;
    const saveDiscovery = vi.fn();
    const log = vi.fn();

    const result = await storeMyInvestorDiscovery(
      {
        log,
        now: "2026-11-04T17:29:36.000Z",
        store: { connectedSources: { saveDiscovery } } as never,
        today: "2026-11-04",
      },
      { reader, sourceId: "source" },
    );

    expect(result).toEqual({ error: MYINVESTOR_READ_FAILED, ok: false });
    expect(saveDiscovery).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[myinvestor] reading the products failed",
      expect.objectContaining({
        httpStatus: 502,
        kind: "network_or_waf",
        step: "orders",
      }),
    );
  });
});
