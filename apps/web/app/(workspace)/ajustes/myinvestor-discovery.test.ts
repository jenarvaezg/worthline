/**
 * The stored discovery is validated at the boundary (#1876): a document this version
 * wrote comes back whole; anything else is null, so the fold reads MyInvestor again.
 * The round trip over the fixtures is the first-start flow's (`storeMyInvestorDiscovery`).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  MYINVESTOR_DISCOVERY_VERSION,
  type MyInvestorDiscovery,
  parseMyInvestorDiscovery,
  serializeMyInvestorDiscovery,
} from "./myinvestor-discovery";

const DISCOVERY: MyInvestorDiscovery = {
  accounts: [
    {
      key: "portfolio:acc-sint-7",
      kind: "portfolio",
      label: "Cartera indexada",
      otherHolder: false,
      sub: "Gestionada",
    },
    {
      key: "pension:acc-sint-9",
      kind: "pension",
      label: "Planes de pensiones",
      otherHolder: true,
      sub: "De otro titular",
    },
  ],
  contributions: [
    {
      amount: "73.19",
      contributionId: "ctb-sint-1",
      contributionType: null,
      currency: "EUR",
      fromAccountId: null,
      fundName: "Plan sintético",
      productCode: "N0000",
      status: "ACTIVE",
      subscriptionType: null,
      timeFrame: {
        endDate: null,
        nextExecutionDate: "2026-12-07",
        recurrence: "ONE_MONTH",
        startDate: "2026-01-07",
      },
      toAccountId: "acc-sint-9",
      toAccountType: "PENSION_PLAN",
    },
  ],
  operations: [
    {
      dateKey: "2026-03-11",
      key: "myinvestor:op-sint-1",
      payload: {
        accountId: "acc-sint-9",
        amount: "41.37",
        currency: "EUR",
        executedAt: "2026-03-11",
        fees: "0",
        instrument: { code: "N0000", scheme: "dgs" },
        instrumentName: "Plan sintético",
        kind: "operation",
        operation: "transfer_in",
        pricePerUnit: null,
        product: "pension_plan",
        reference: "op-sint-1",
        sourceType: "EXTERNAL_TRANSFER_IN",
        transfer: {
          inheritedCost: "pending",
          pairing: "external_in",
          transferId: "myinvestor-external:op-sint-1",
        },
        units: "3.0071",
      },
    },
  ],
  products: [
    {
      accountKey: "portfolio:acc-sint-7",
      cash: null,
      declared: { currency: "EUR", value: "917.43" },
      identifier: null,
      instrument: null,
      key: "portfolio:acc-sint-7",
      kind: "managed",
      members: ["Fondo sintético", "Efectivo"],
      name: "Cartera indexada",
      otherHolder: false,
      portfolioKey: null,
      units: null,
    },
    {
      accountKey: "portfolio:acc-sint-7",
      cash: { balance: "12.07", currency: "EUR", withheld: "0" },
      declared: null,
      identifier: "···0042",
      instrument: null,
      key: "cash:acc-sint-8",
      kind: "cash",
      members: [],
      name: "Efectivo",
      otherHolder: false,
      portfolioKey: "portfolio:acc-sint-7",
      units: null,
    },
  ],
  readOn: "2026-11-04",
  version: MYINVESTOR_DISCOVERY_VERSION,
};

describe("parseMyInvestorDiscovery", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a document this version wrote, managed portfolio included, comes back whole", () => {
    expect(parseMyInvestorDiscovery(serializeMyInvestorDiscovery(DISCOVERY))).toEqual(
      DISCOVERY,
    );
  });

  test("a document from before the scheduled contributions still reads", () => {
    const { contributions: _, ...older } = DISCOVERY;
    expect(parseMyInvestorDiscovery(JSON.stringify(older))).toEqual(older);
  });

  test("a version-1 document is read again, not trusted", () => {
    expect(
      parseMyInvestorDiscovery(JSON.stringify({ ...DISCOVERY, version: 1 })),
    ).toBeNull();
  });

  test("a product without the managed-portfolio fields of version 2 is not one", () => {
    const [managed] = DISCOVERY.products;
    const { portfolioKey: _, declared: __, ...v1Product } = managed!;
    expect(
      parseMyInvestorDiscovery(JSON.stringify({ ...DISCOVERY, products: [v1Product] })),
    ).toBeNull();
  });

  test("an operation of another shape is not trusted: the fold reads again", () => {
    const [operation] = DISCOVERY.operations;
    const broken = { ...operation, payload: { ...operation!.payload, units: 3.0071 } };
    expect(
      parseMyInvestorDiscovery(JSON.stringify({ ...DISCOVERY, operations: [broken] })),
    ).toBeNull();
  });

  test("a row that is not JSON is null, and says so in the log", () => {
    expect(parseMyInvestorDiscovery('{"version":2,')).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
