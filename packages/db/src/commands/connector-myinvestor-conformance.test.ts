/**
 * The MyInvestor adapter (#1878, ADR 0115) is the first live source on the ingestion
 * port of ADR 0066: it earns the port's guarantees by passing the common conformance
 * suite, then proves what a live, date-cursored source adds — the overlap that picks
 * up an order which settled after the last sync, and the two legs of a traspaso
 * landing together.
 *
 * The conformance suite runs on a fake reader that serves the anonymized fixtures of
 * #1887 through their own loader (`@pricing/__fixtures__/myinvestor`, by the
 * manifest): the accounts are the captured ones and every order of the suite's ledger
 * is a captured fund order re-keyed and re-dated. The captured history also goes
 * through the in-memory host whole. The live-source scenarios below use invented
 * orders, since the capture has no order in progress to settle.
 */

import { fixtureTransport } from "@pricing/myinvestor/testing/fake-transport";
import type { ReferenceEvent } from "@worthline/domain";
import {
  createMyInvestorAdapter,
  createMyInvestorClient,
  type MyInvestorError,
  type MyInvestorOperationFact,
  type MyInvestorOrder,
  type MyInvestorReader,
  type MyInvestorResult,
} from "@worthline/pricing";
import { describe, expect, test } from "vitest";

import {
  createInMemoryConnectorHost,
  describeConnectorConformance,
} from "./connector-conformance";

const ACCOUNT = "valores-inventada";
/** The suite's host commits as of this day; the fake syncs on it too. */
const TODAY = "2026-07-19";
/** The day the fixtures were captured: the `dateTo` their manifest records. */
const CAPTURE_DAY = "2026-11-04";
const CAPTURE_RANGE = { from: "2000-01-01", to: CAPTURE_DAY } as const;

const NETWORK_DOWN: MyInvestorError = {
  kind: "network_or_waf",
  step: "positions",
  httpStatus: null,
  code: null,
  attempts: 1,
};

function ok<T>(value: T): MyInvestorResult<T> {
  return { ok: true, value };
}

function fundOrder(overrides: Partial<MyInvestorOrder>): MyInvestorOrder {
  return {
    reference: "ref",
    accountId: ACCOUNT,
    orderDate: "2026-03-01",
    isin: "ES0000000001",
    dgsCode: null,
    ticker: null,
    fundName: null,
    operationType: "INVESTMENT_FUNDS_SUBSCRIPTION",
    orderType: "ORDINARY",
    status: "COMPLETE",
    cash: "250.75",
    shares: "12.5",
    executionNav: "20.06",
    amountToBlock: "250.75",
    currency: "EUR",
    productType: "IIC",
    market: null,
    effectiveDate: null,
    expirationDate: null,
    ...overrides,
  };
}

/** A reader with one funds-only securities account whose orders the test controls. */
function fakeReader(initial: readonly MyInvestorOrder[]) {
  let orders = [...initial];
  let failNext = false;
  const unused = async (): Promise<never> => {
    throw new Error("not read by fetch_transactions");
  };

  const reader: MyInvestorReader = {
    tokens: () => ({ accessToken: "a", refreshToken: null }),
    securitiesAccounts: async () => {
      if (failNext) {
        failNext = false;
        return { ok: false, error: NETWORK_DOWN };
      }
      return ok([
        {
          accountId: ACCOUNT,
          cashAccountId: null,
          accountType: "SECURITIES_ACCOUNT",
          status: "ACTIVE",
          hasFundsOperations: true,
          hasBrokerOperations: false,
        },
      ]);
    },
    securitiesOrders: async (_accountId, range) =>
      ok(orders.filter((o) => o.orderDate >= range.from && o.orderDate <= range.to)),
    pensionAccounts: async () => ok([]),
    cashAccounts: unused,
    securitiesAccount: unused,
    brokerOrders: unused,
    brokerOrderDetail: unused,
    pendingFundTransfers: unused,
    pensionPlans: unused,
    pensionOrders: unused,
    pensionShareSeries: unused,
    automaticContributions: unused,
    portfolios: unused,
  };

  return {
    reader,
    setOrders: (next: readonly MyInvestorOrder[]) => {
      orders = [...next];
    },
    failNextRead: () => {
      failNext = true;
    },
  };
}

/** The real client and reader over the fixtures, answered by their manifest. */
function capturedReader(): MyInvestorReader {
  return createMyInvestorClient({
    transport: fixtureTransport(),
    deviceId: "device-sintetico",
    sleep: async () => {},
  }).reader({ accessToken: "access-sintetico", refreshToken: null });
}

function unwrap<T>(result: MyInvestorResult<T>): T {
  if (!result.ok) throw new Error(`Lectura de fixture fallida: ${result.error.kind}`);
  return result.value;
}

/** The first finished fund subscription of the capture: the shape of every ledger order. */
async function capturedSubscription(): Promise<MyInvestorOrder> {
  const reader = capturedReader();
  for (const account of unwrap(await reader.securitiesAccounts())) {
    if (account.hasFundsOperations === false) continue;
    const orders = unwrap(
      await reader.securitiesOrders(account.accountId, CAPTURE_RANGE),
    );
    const found = orders.find(
      (order) =>
        order.status === "COMPLETE" &&
        order.operationType === "INVESTMENT_FUNDS_SUBSCRIPTION",
    );
    if (found) return found;
  }
  throw new Error("Los fixtures no traen ninguna suscripción de fondos terminada");
}

const SUBSCRIPTION = await capturedSubscription();

/**
 * The captured accounts, with the suite's ledger as the only orders: each event is the
 * captured subscription re-keyed and re-dated, in the account it was captured in.
 */
function capturedLedgerReader(events: readonly ReferenceEvent[]) {
  const captured = capturedReader();
  const orders = events.map((event) => ({
    ...SUBSCRIPTION,
    reference: event.key,
    orderDate: event.dateKey,
  }));
  let failNext = false;
  const reader: MyInvestorReader = {
    ...captured,
    securitiesAccounts: async () => {
      if (failNext) {
        failNext = false;
        return { ok: false, error: NETWORK_DOWN };
      }
      return captured.securitiesAccounts();
    },
    securitiesOrders: async (accountId, range) =>
      ok(
        accountId === SUBSCRIPTION.accountId
          ? orders.filter((o) => o.orderDate >= range.from && o.orderDate <= range.to)
          : [],
      ),
    brokerOrders: async () => ok([]),
    pensionOrders: async () => ok([]),
  };
  return {
    reader,
    failNextRead: () => {
      failNext = true;
    },
  };
}

describeConnectorConformance("myinvestor", (events) => {
  const fake = capturedLedgerReader(events);
  const adapter = createMyInvestorAdapter({ reader: fake.reader, today: TODAY });
  let disconnected = false;
  let fetches = 0;
  return {
    adapter: {
      ...adapter,
      fetch: (request) => {
        fetches += 1;
        return adapter.fetch(request);
      },
      disconnect: async () => {
        await adapter.disconnect?.();
        disconnected = true;
      },
    },
    isDisconnected: () => disconnected,
    fetchCount: () => fetches,
    failNextFetch: () => fake.failNextRead(),
  };
});

describe("myinvestor — the captured history through the in-memory host", () => {
  test("lands once, in one batch and one ripple, and a replay applies nothing", async () => {
    const host = createInMemoryConnectorHost();
    const adapter = createMyInvestorAdapter({
      reader: capturedReader(),
      today: CAPTURE_DAY,
    });
    const expected = await adapter.fetch({
      capability: "fetch_transactions",
      cursor: null,
    });
    const keys = expected.facts.map((fact) => fact.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);

    const first = await host.runSync(adapter, "fetch_transactions");
    expect(first.ok && first.value.applied).toBe(keys.length);
    expect(host.appliedKeys()).toEqual(keys);
    expect(host.batchCount()).toBe(1);
    expect(host.rippleFloors()).toEqual([expected.facts[0]?.dateKey]);
    expect(host.cursor()).toBe(CAPTURE_DAY);

    const replay = await host.runSync(adapter, "fetch_transactions", { cursor: null });
    expect(replay.ok && replay.value.applied).toBe(0);
    expect(host.appliedKeys()).toEqual(keys);
  });
});

describe("myinvestor — a live source with a dated cursor", () => {
  test("an order still in progress at one sync lands at the next through the overlap", async () => {
    const host = createInMemoryConnectorHost();
    const settled = fundOrder({ reference: "liquidada", orderDate: "2026-07-01" });
    const pending = fundOrder({
      reference: "en-curso",
      orderDate: "2026-07-15",
      status: "IN_PROGRESS",
    });
    const fake = fakeReader([settled, pending]);

    const first = await host.runSync(
      createMyInvestorAdapter({ reader: fake.reader, today: "2026-07-16" }),
      "fetch_transactions",
    );
    expect(first.ok && first.value.applied).toBe(1);
    expect(host.cursor()).toBe("2026-07-16");

    // It settles days later, dated BEFORE the cursor: only the overlap reads it again.
    fake.setOrders([settled, { ...pending, status: "COMPLETE" }]);
    const second = await host.runSync(
      createMyInvestorAdapter({ reader: fake.reader, today: "2026-07-25" }),
      "fetch_transactions",
    );

    expect(second.ok && second.value.applied).toBe(1);
    expect(host.appliedKeys()).toEqual(["liquidada", "en-curso"]);
    expect(host.cursor()).toBe("2026-07-25");
  });

  test("both legs of a switch land in one batch with one ripple, only once both are finished", async () => {
    const host = createInMemoryConnectorHost();
    const out = fundOrder({
      reference: "switch-sale",
      orderDate: "2026-07-10",
      operationType: "IIC_SWITCH_DEREGISTRATION",
    });
    const incoming = fundOrder({
      reference: "switch-entra",
      orderDate: "2026-07-10",
      operationType: "IIC_SWITCH_REGISTRATION",
      isin: "ES0000000002",
      status: "IN_PROGRESS",
    });
    const fake = fakeReader([out, incoming]);

    const waiting = await host.runSync(
      createMyInvestorAdapter({ reader: fake.reader, today: "2026-07-11" }),
      "fetch_transactions",
    );
    expect(waiting.ok && waiting.value.applied).toBe(0);

    fake.setOrders([out, { ...incoming, status: "COMPLETE" }]);
    const batchesBefore = host.batchCount();
    let pair: MyInvestorOperationFact[] = [];
    const adapter = createMyInvestorAdapter({ reader: fake.reader, today: "2026-07-14" });
    const done = await host.runSync(
      {
        ...adapter,
        fetch: async (request) => {
          const batch = await adapter.fetch(request);
          pair = batch.facts.map((fact) => fact.payload as MyInvestorOperationFact);
          return batch;
        },
      },
      "fetch_transactions",
    );

    expect(done.ok && done.value.applied).toBe(2);
    expect(host.batchCount()).toBe(batchesBefore + 1);
    expect(host.rippleFloors()).toEqual(["2026-07-10"]);
    const ids = pair.map((leg) =>
      leg.transfer?.pairing === "paired" ? leg.transfer.transferId : null,
    );
    expect(ids[0]).not.toBeNull();
    expect(ids[0]).toBe(ids[1]);
  });
});
