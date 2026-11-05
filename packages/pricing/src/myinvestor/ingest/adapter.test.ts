/**
 * The MyInvestor ingestion adapter (#1878) end to end over the S1 fixtures (#1887):
 * the real client and reader on a fake transport, never the network. Figures from
 * the fixtures are only compared with themselves.
 */

import { createMyInvestorClient } from "@pricing/myinvestor/client";
import {
  fixtureTransport,
  reply,
  scriptedTransport,
} from "@pricing/myinvestor/testing/fake-transport";
import type {
  MyInvestorRequest,
  MyInvestorTransport,
} from "@pricing/myinvestor/transport";
import { addUnits, compareUnits, supportsCapability } from "@worthline/domain";
import { describe, expect, it } from "vitest";
import {
  calendarYearWindows,
  createMyInvestorAdapter,
  MYINVESTOR_ADAPTER_ID,
  MyInvestorSyncError,
} from "./adapter";
import type {
  MyInvestorCashBalanceFact,
  MyInvestorOperationFact,
  MyInvestorPositionFact,
} from "./facts";
import { holdingKey, unitsByHolding } from "./normalize";

const TOKENS = { accessToken: "access-sintetico", refreshToken: "refresh-sintetico" };
/** The day the captures were taken: the manifest's `dateTo`. */
const CAPTURE_DAY = "2026-11-04";

function adapterOn(transport: MyInvestorTransport, today = CAPTURE_DAY) {
  const client = createMyInvestorClient({
    transport,
    deviceId: "device-sintetico",
    sleep: async () => {},
  });
  return createMyInvestorAdapter({ reader: client.reader(TOKENS), today });
}

const EMPTY_LIST = JSON.stringify({ payload: { data: [] } });
const ORDER_LISTS = /\/orders$|\/stock-orders$/;
const BROKER_LIST = /\/stock-orders$/;

/** The fixtures for everything but the order lists, which come back empty. */
function emptyOrdersTransport(): MyInvestorTransport & { requests: MyInvestorRequest[] } {
  const fixtures = fixtureTransport();
  return {
    requests: fixtures.requests,
    async send(request) {
      if (ORDER_LISTS.test(request.path)) {
        fixtures.requests.push(request);
        return reply(200, EMPTY_LIST);
      }
      return fixtures.send(request);
    },
  };
}

describe("the MyInvestor adapter", () => {
  it("names itself and declares what it can do", () => {
    const adapter = adapterOn(fixtureTransport());

    expect(adapter.id).toBe(MYINVESTOR_ADAPTER_ID);
    for (const kind of [
      "discover_accounts",
      "fetch_transactions",
      "fetch_positions",
      "fetch_balances",
      "disconnect",
    ] as const) {
      expect(supportsCapability(adapter, kind), kind).toBe(true);
    }
  });

  it("the first sync reads the whole history up to today and resumes from today", async () => {
    const transport = fixtureTransport();
    const batch = await adapterOn(transport).fetch({
      capability: "fetch_transactions",
      cursor: null,
    });

    expect(batch.cursor).toBe(CAPTURE_DAY);
    expect(batch.facts.length).toBeGreaterThan(0);
    const windows = transport.requests
      .filter(
        (request) => ORDER_LISTS.test(request.path) && !BROKER_LIST.test(request.path),
      )
      .map((request) => [request.query?.dateFrom, request.query?.dateTo]);
    expect(windows.length).toBeGreaterThan(0);
    for (const window of windows) {
      expect([
        ["2000-01-01", CAPTURE_DAY],
        ["20000101", "20261104"],
      ]).toContainEqual(window);
    }
    const brokerWindows = transport.requests
      .filter((request) => BROKER_LIST.test(request.path))
      .map((request) => ({ from: request.query?.dateFrom, to: request.query?.dateTo }));
    expect(brokerWindows.length).toBeGreaterThan(0);
    expect(new Set(brokerWindows.map((window) => JSON.stringify(window)))).toEqual(
      new Set(
        calendarYearWindows({ from: "2000-01-01", to: CAPTURE_DAY }).map((window) =>
          JSON.stringify(window),
        ),
      ),
    );
  });

  it("a long broker history is read one year at a time: the whole range is a 500 at MyInvestor", async () => {
    const fixtures = fixtureTransport();
    const adapter = adapterOn({
      async send(request) {
        const { dateFrom, dateTo } = request.query ?? {};
        const longerThanAYear =
          dateFrom !== undefined &&
          dateTo !== undefined &&
          dateFrom.slice(0, 4) !== dateTo.slice(0, 4);
        return BROKER_LIST.test(request.path) && longerThanAYear
          ? reply(500, "{}")
          : fixtures.send(request);
      },
    });

    const batch = await adapter.fetch({ capability: "fetch_transactions", cursor: null });

    const broker = batch.facts.filter(
      (fact) => (fact.payload as MyInvestorOperationFact).product === "broker",
    );
    expect(broker.length).toBeGreaterThan(0);
  });

  it("never asks for cash movements, nor anything but reads", async () => {
    const transport = fixtureTransport();
    const adapter = adapterOn(transport);
    await adapter.fetch({ capability: "fetch_transactions", cursor: null });
    await adapter.fetch({ capability: "fetch_positions", cursor: null });
    await adapter.fetch({ capability: "fetch_balances", cursor: null });
    await adapter.discoverAccounts?.();

    expect(transport.requests.every((request) => request.method === "GET")).toBe(true);
    for (const request of transport.requests) {
      expect(request.path).not.toMatch(/movement|historical-balance|transactions/i);
    }
  });

  it("asks a broker order's detail only once it is finished", async () => {
    const transport = fixtureTransport();
    const batch = await adapterOn(transport).fetch({
      capability: "fetch_transactions",
      cursor: null,
    });

    const details = transport.requests.filter((request) =>
      /^\/broker\/v2\/stock-orders\/[^/]+$/.test(request.path),
    );
    const brokerFacts = batch.facts.filter(
      (fact) => (fact.payload as MyInvestorOperationFact).product === "broker",
    );
    expect(details.length).toBeGreaterThan(0);
    expect(brokerFacts).toHaveLength(details.length);
    for (const fact of brokerFacts) expect(fact.key).toMatch(/^broker:/);
  });

  it("a later sync re-reads the 30 days before the last good one", async () => {
    const transport = emptyOrdersTransport();
    const batch = await adapterOn(transport, "2026-11-10").fetch({
      capability: "fetch_transactions",
      cursor: CAPTURE_DAY,
    });

    expect(batch).toEqual({ facts: [], cursor: "2026-11-10" });
    const windows = transport.requests
      .filter((request) => ORDER_LISTS.test(request.path))
      .map((request) => [request.query?.dateFrom, request.query?.dateTo]);
    expect(windows.length).toBeGreaterThan(0);
    for (const window of windows) {
      expect([
        ["2026-10-05", "2026-11-10"],
        ["20261005", "20261110"],
      ]).toContainEqual(window);
    }
  });

  it("P8: the orders rebuild exactly the units MyInvestor reports today, in every holding", async () => {
    const adapter = adapterOn(fixtureTransport());
    const operations = await adapter.fetch({
      capability: "fetch_transactions",
      cursor: null,
    });
    const positions = await adapter.fetch({
      capability: "fetch_positions",
      cursor: null,
    });

    const folded = unitsByHolding(
      operations.facts.map((fact) => fact.payload as MyInvestorOperationFact),
    );
    const reported = positions.facts.map(
      (fact) => fact.payload as MyInvestorPositionFact,
    );
    expect(reported.length).toBeGreaterThan(0);
    expect(new Set(reported.map((position) => position.product))).toEqual(
      new Set(["fund", "broker", "pension_plan"]),
    );
    for (const position of reported) {
      const key = holdingKey(position.accountId, position.instrument);
      expect(compareUnits(folded.get(key) ?? "0", position.units), key).toBe(0);
    }
    const reportedKeys = new Set(
      reported.map((position) => holdingKey(position.accountId, position.instrument)),
    );
    for (const [key, units] of folded) {
      if (!reportedKeys.has(key)) expect(compareUnits(units, "0"), key).toBe(0);
    }
  });

  it("positions and balances are today's picture: they never move the orders' cursor", async () => {
    const adapter = adapterOn(fixtureTransport());

    for (const capability of ["fetch_positions", "fetch_balances"] as const) {
      const fromStart = await adapter.fetch({ capability, cursor: null });
      const resumed = await adapter.fetch({ capability, cursor: "2026-10-01" });
      expect(fromStart.cursor, capability).toBeNull();
      expect(resumed.cursor, capability).toBe("2026-10-01");
      for (const fact of fromStart.facts) expect(fact.dateKey).toBe(CAPTURE_DAY);
      expect(resumed.facts.map((fact) => fact.key)).toEqual(
        fromStart.facts.map((fact) => fact.key),
      );
    }
  });

  it("a cash balance counts what is held for orders in progress", async () => {
    const batch = await adapterOn(fixtureTransport()).fetch({
      capability: "fetch_balances",
      cursor: null,
    });

    const balances = batch.facts.map((fact) => fact.payload as MyInvestorCashBalanceFact);
    expect(balances.length).toBeGreaterThan(0);
    expect(balances.some((balance) => compareUnits(balance.withheld, "0") > 0)).toBe(
      true,
    );
    for (const balance of balances) {
      expect(balance.kind).toBe("cash_balance");
      expect(balance.accountId).toMatch(/^cash:/);
      expect(
        compareUnits(balance.balance, addUnits(balance.available, balance.withheld)),
      ).toBe(0);
    }
  });

  it("discovers every account, with what belongs to someone else unticked", async () => {
    const accounts = (await adapterOn(fixtureTransport()).discoverAccounts?.()) ?? [];

    const kinds = new Set(accounts.map((account) => account.externalId.split(":")[0]));
    expect(kinds).toEqual(new Set(["cash", "securities", "pension"]));
    expect(accounts.some((account) => account.includedByDefault === false)).toBe(true);
    expect(accounts.some((account) => account.includedByDefault === true)).toBe(true);
    expect(new Set(accounts.map((account) => account.externalId)).size).toBe(
      accounts.length,
    );
  });

  it("the facts name their account as discovery does", async () => {
    const adapter = adapterOn(fixtureTransport());
    const accounts = new Set(
      ((await adapter.discoverAccounts?.()) ?? []).map((account) => account.externalId),
    );

    for (const capability of [
      "fetch_transactions",
      "fetch_positions",
      "fetch_balances",
    ] as const) {
      const batch = await adapter.fetch({ capability, cursor: null });
      for (const fact of batch.facts) {
        const payload = fact.payload as { accountId: string };
        expect(accounts.has(payload.accountId), payload.accountId).toBe(true);
      }
    }
  });

  it("a failed read rejects the fetch with the client's typed error, and touches nothing", async () => {
    const client = createMyInvestorClient({
      transport: scriptedTransport([reply(401)]),
      deviceId: "device-sintetico",
      sleep: async () => {},
    });
    const adapter = createMyInvestorAdapter({
      reader: client.reader({ accessToken: "caducado", refreshToken: null }),
      today: CAPTURE_DAY,
    });

    const failure = await adapter
      .fetch({ capability: "fetch_transactions", cursor: null })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MyInvestorSyncError);
    expect((failure as MyInvestorSyncError).error.kind).toBe("session_expired");
  });

  it("a failed order list names its call and its account's type, never the account", async () => {
    const fixtures = fixtureTransport();
    const adapter = adapterOn({
      async send(request) {
        return /\/securities-accounts\/[^/]+\/orders$/.test(request.path)
          ? reply(500, "{}")
          : fixtures.send(request);
      },
    });

    const failure = await adapter
      .fetch({ capability: "fetch_transactions", cursor: null })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MyInvestorSyncError);
    const { error } = failure as MyInvestorSyncError;
    expect(error).toMatchObject({
      accountType: expect.stringMatching(/^[A-Z][A-Z0-9_]*$/),
      call: "securitiesOrders",
      httpStatus: 500,
      kind: "network_or_waf",
      step: "orders",
    });
  });

  it("the broker's years and details go four at a time, never more", async () => {
    const fixtures = fixtureTransport();
    let inFlight = 0;
    let most = 0;
    const adapter = adapterOn({
      async send(request) {
        if (!/\/stock-orders/.test(request.path)) return fixtures.send(request);
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return fixtures.send(request);
      },
    });

    await adapter.fetch({ capability: "fetch_transactions", cursor: null });

    expect(most).toBe(4);
  });

  it("cuts a range into calendar years, and leaves one inside a year as it is", () => {
    expect(calendarYearWindows({ from: "2024-03-10", to: "2026-02-01" })).toEqual([
      { from: "2024-03-10", to: "2024-12-31" },
      { from: "2025-01-01", to: "2025-12-31" },
      { from: "2026-01-01", to: "2026-02-01" },
    ]);
    expect(calendarYearWindows({ from: "2026-10-05", to: "2026-11-10" })).toEqual([
      { from: "2026-10-05", to: "2026-11-10" },
    ]);
    expect(calendarYearWindows({ from: "2025-12-31", to: "2026-01-01" })).toEqual([
      { from: "2025-12-31", to: "2025-12-31" },
      { from: "2026-01-01", to: "2026-01-01" },
    ]);
  });

  it("disconnecting has nothing to undo at MyInvestor: no request is sent", async () => {
    const transport = fixtureTransport();
    await adapterOn(transport).disconnect?.();
    expect(transport.requests).toEqual([]);
  });
});
