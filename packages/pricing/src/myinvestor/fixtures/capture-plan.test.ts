import { describe, expect, it } from "vitest";

import { planCaptureFixtures } from "./capture-plan";
import { createFigureMap } from "./figure-map";
import { createPseudonymizer } from "./pseudonymizer";

const SECRET = "test-secret-not-the-real-one";
const envelope = (data: unknown) =>
  JSON.stringify({
    status: { timestamp: "2026-01-02T08:00:00.000Z", code: "OK" },
    payload: { data },
  });

const RAW = [
  { name: "cash-accounts", text: envelope([{ accountId: "100001", enabledBalance: 2 }]) },
  { name: "customer", text: envelope({ name: "LUCIA", firstSurname: "PRUEBA" }) },
  {
    name: "cash-historical-balance",
    text: envelope([{ balance: 1, date: "2025-01-01" }]),
  },
  {
    name: "securities-orders-100002",
    text: envelope([
      {
        securitiesAccountId: "100002",
        reference: "202501010000001",
        operationType: "INVESTMENT_FUNDS_SUBSCRIPTION",
        productType: "IIC",
        status: "IN_PROGRESS",
        cash: 5,
        shares: 0,
      },
    ]),
  },
  { name: "pension-orders-100003", text: envelope([]) },
];

function plan() {
  const pseudonyms = createPseudonymizer(SECRET);
  return {
    pseudonyms,
    plan: planCaptureFixtures(RAW, { pseudonyms, figures: createFigureMap(SECRET) }),
  };
}

describe("planCaptureFixtures", () => {
  it("names each fixture after its endpoint with the fake account id", () => {
    const { pseudonyms, plan: result } = plan();
    expect(result.fixtures.map((fixture) => fixture.file)).toEqual([
      "capture/cash-accounts.json",
      `capture/pension-orders-${pseudonyms.digits("100003")}.json`,
      `capture/securities-orders-${pseudonyms.digits("100002")}.json`,
    ]);
  });

  it("uses the same fake for the id in the file name and inside the body", () => {
    const { pseudonyms, plan: result } = plan();
    const orders = result.fixtures.find((fixture) =>
      fixture.file.includes("securities-orders"),
    );
    expect(JSON.parse(orders?.text ?? "{}").payload.data[0].securitiesAccountId).toBe(
      pseudonyms.digits("100002"),
    );
  });

  it("describes the request of every fixture in the manifest", () => {
    const { pseudonyms, plan: result } = plan();
    const fake = pseudonyms.digits("100003");
    expect(result.manifest).toContainEqual({
      file: `capture/pension-orders-${fake}.json`,
      method: "GET",
      path: `/cperf-server/api/v2/pension-accounts/${fake}/orders`,
      query: { dateFrom: "20000101", dateTo: "20260102" },
      status: 200,
      origin: "capture",
      note: null,
    });
    expect(result.manifest).toHaveLength(result.fixtures.length);
  });

  it("leaves out the responses the connector does not read, and says so", () => {
    expect(plan().plan.skipped).toEqual(["cash-historical-balance", "customer"]);
  });

  it("refuses a capture it does not know", () => {
    const pseudonyms = createPseudonymizer(SECRET);
    expect(() =>
      planCaptureFixtures([{ name: "something-new", text: envelope([]) }], {
        pseudonyms,
        figures: createFigureMap(SECRET),
      }),
    ).toThrow(/something-new/);
  });
});
