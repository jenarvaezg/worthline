import type { InvestmentOperation } from "@worthline/domain";
import type { MyInvestorContribution } from "@worthline/pricing";
import { describe, expect, test } from "vitest";
import {
  addBusinessDays,
  type MyInvestorSchedule,
  myInvestorArrivals,
  myInvestorContributionProductKey,
  myInvestorMissingArrivals,
  myInvestorScheduledEntries,
  myInvestorSchedulesByAsset,
  myInvestorWaitingEntries,
} from "./myinvestor-contributions";
import {
  MYINVESTOR_DISCOVERY_VERSION,
  type MyInvestorDiscovery,
} from "./myinvestor-discovery";

const PLAN_KEY = "pension:7741|dgs:N0042";

function contribution(
  overrides: Partial<MyInvestorContribution> = {},
): MyInvestorContribution {
  return {
    amount: "87.43",
    contributionId: "c-1",
    contributionType: "ONE_DATE",
    currency: "EUR",
    fromAccountId: "5519",
    fundName: "Plan Inventado PP",
    productCode: "N0042",
    status: "ACTIVE",
    subscriptionType: "SUCCESSIVE_SUBSCRIPTION",
    timeFrame: {
      endDate: null,
      nextExecutionDate: "2026-12-05",
      recurrence: "ONE_MONTH",
      startDate: "2025-03-05",
    },
    toAccountId: "7741",
    toAccountType: "PENSION_PLAN",
    ...overrides,
  };
}

function discovery(contributions: MyInvestorContribution[]): MyInvestorDiscovery {
  return {
    accounts: [],
    contributions,
    operations: [],
    products: [
      {
        accountKey: "cash:5519",
        cash: { balance: "3.17", currency: "EUR", withheld: "0" },
        declared: null,
        identifier: "···5519",
        instrument: null,
        key: "cash:5519",
        kind: "cash",
        members: [],
        name: "Cuenta Huerto",
        otherHolder: false,
        portfolioKey: null,
        units: null,
      },
    ],
    readOn: "2026-11-14",
    version: MYINVESTOR_DISCOVERY_VERSION,
  };
}

function schedule(overrides: Partial<MyInvestorContribution> = {}): MyInvestorSchedule {
  const byAsset = myInvestorSchedulesByAsset(discovery([contribution(overrides)]), [
    { assetId: "pp", productKey: PLAN_KEY },
  ]);
  const [only] = byAsset.get("pp") ?? [];
  if (!only) throw new Error("no schedule");
  return only;
}

function buy(executedAt: string, id = executedAt): InvestmentOperation {
  return {
    assetId: "pp",
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id,
    kind: "buy",
    pricePerUnit: "8.743",
    units: "10",
  };
}

describe("myInvestorContributionProductKey", () => {
  test("a plan's is its pension account and DGS code; a fund's, its securities account and ISIN", () => {
    expect(myInvestorContributionProductKey(contribution())).toBe(PLAN_KEY);
    expect(
      myInvestorContributionProductKey(
        contribution({
          productCode: "IE00BYX00X01",
          toAccountId: "6603",
          toAccountType: "SECURITIES_ACCOUNT",
        }),
      ),
    ).toBe("securities:6603|isin:IE00BYX00X01");
    // A robo-advisor portfolio's, or one without a destination, is no holding's.
    expect(
      myInvestorContributionProductKey(contribution({ toAccountType: "OTHER" })),
    ).toBeNull();
  });
});

describe("myInvestorSchedulesByAsset", () => {
  test("hands each linked holding its scheduled contributions, with the account they come from", () => {
    const byAsset = myInvestorSchedulesByAsset(
      discovery([
        contribution(),
        contribution({ contributionId: "c-2", productCode: "N0099" }),
      ]),
      [{ assetId: "pp", productKey: PLAN_KEY }],
    );
    expect([...byAsset.keys()]).toEqual(["pp"]);
    const [only] = byAsset.get("pp") ?? [];
    expect(only).toMatchObject({
      active: true,
      amountMinor: 8_743,
      fromAccount: "Cuenta Huerto",
      id: "c-1",
      line: {
        cadence: { dayOfMonth: 5, kind: "monthly" },
        destinationHoldingId: "pp",
        startDate: "2025-03-05",
      },
      nextDate: "2026-12-05",
    });
  });

  test("a document kept before the sync read the contributions has none", () => {
    const { contributions: _none, ...older } = discovery([]);
    expect(
      myInvestorSchedulesByAsset(older, [{ assetId: "pp", productKey: PLAN_KEY }]).size,
    ).toBe(0);
  });

  test("the day of the month is the next execution's, not the start's", () => {
    expect(
      schedule({
        timeFrame: {
          endDate: null,
          nextExecutionDate: "2026-12-01",
          recurrence: "ONE_MONTH",
          startDate: "2025-10-02",
        },
      }).line?.cadence,
    ).toEqual({ dayOfMonth: 1, kind: "monthly" });
  });

  test("a cancelled one ends the day before the execution it never made", () => {
    const cancelled = schedule({
      status: "CANCELED",
      timeFrame: {
        endDate: "2045-03-05",
        nextExecutionDate: "2026-07-05",
        recurrence: "ONE_MONTH",
        startDate: "2025-03-05",
      },
    });
    expect(cancelled.active).toBe(false);
    expect(cancelled.line?.endDate).toBe("2026-07-04");
  });

  test("a recurrence worthline cannot read has no calendar", () => {
    expect(
      schedule({
        timeFrame: {
          endDate: null,
          nextExecutionDate: "2026-12-05",
          recurrence: "SEVEN_FORTNIGHTS",
          startDate: "2025-03-05",
        },
      }).line,
    ).toBeNull();
  });
});

describe("addBusinessDays", () => {
  test("skips the weekend", () => {
    // Thursday 5 Nov 2026 + 5 business days = Thursday 12 Nov.
    expect(addBusinessDays("2026-11-05", 5)).toBe("2026-11-12");
    // Sunday 1 Nov 2026 + 5 = Friday 6 Nov.
    expect(addBusinessDays("2026-11-01", 5)).toBe("2026-11-06");
  });
});

describe("myInvestorArrivals", () => {
  const monthly = () => schedule();

  test("a monthly contribution with its order of the month does not warn", () => {
    const rows = myInvestorArrivals(monthly(), {
      ledger: [buy("2026-09-08"), buy("2026-10-06"), buy("2026-11-05")],
      readOn: "2026-11-20",
      savedPassword: true,
      today: "2026-11-20",
    });
    expect(rows.slice(0, 4)).toEqual([
      { date: "2026-12-05", order: null, status: "scheduled" },
      {
        date: "2026-11-05",
        order: { amountMinor: 8_743, date: "2026-11-05" },
        status: "arrived",
      },
      {
        date: "2026-10-05",
        order: { amountMinor: 8_743, date: "2026-10-06" },
        status: "arrived",
      },
      {
        date: "2026-09-05",
        order: { amountMinor: 8_743, date: "2026-09-08" },
        status: "arrived",
      },
    ]);
    expect(myInvestorMissingArrivals(rows)).toEqual([]);
  });

  test("without the order, once the window has passed, it warns with its date", () => {
    const rows = myInvestorArrivals(monthly(), {
      ledger: [buy("2026-09-08"), buy("2026-10-06")],
      readOn: "2026-11-13",
      savedPassword: true,
      today: "2026-11-13",
    });
    expect(rows[1]).toEqual({ date: "2026-11-05", order: null, status: "missing" });
    expect(myInvestorMissingArrivals(rows).map((row) => row.date)).toEqual([
      "2026-11-05",
    ]);
  });

  test("inside the window it is still on its way: no warning yet", () => {
    const rows = myInvestorArrivals(monthly(), {
      ledger: [buy("2026-10-06")],
      // 5 Nov + 5 business days = 12 Nov: the read of the 12th can still miss it.
      readOn: "2026-11-12",
      savedPassword: true,
      today: "2026-11-12",
    });
    expect(rows[1]?.status).toBe("waiting");
    expect(myInvestorMissingArrivals(rows)).toEqual([]);
  });

  test("a window that closed after the last read is «sin comprobar»: the read is too old to say", () => {
    const rows = myInvestorArrivals(monthly(), {
      ledger: [buy("2026-10-06")],
      readOn: "2026-11-09",
      savedPassword: true,
      today: "2026-11-30",
    });
    expect(rows[1]?.status).toBe("unchecked");
    expect(myInvestorMissingArrivals(rows)).toEqual([]);
  });

  test("a window still open today is «en plazo», whatever the read", () => {
    const rows = myInvestorArrivals(monthly(), {
      ledger: [buy("2026-10-06")],
      readOn: "2026-11-09",
      savedPassword: false,
      today: "2026-11-10",
    });
    expect(rows[1]?.status).toBe("waiting");
  });

  test("a quarterly schedule on the 30th keeps its day through February", () => {
    const quarterly = schedule({
      timeFrame: {
        endDate: null,
        nextExecutionDate: "2026-11-30",
        recurrence: "THREE_MONTHS",
        startDate: "2025-05-30",
      },
    });
    const rows = myInvestorArrivals(quarterly, {
      ledger: [],
      readOn: "2026-11-20",
      savedPassword: true,
      today: "2026-11-20",
    });
    expect(rows.map((row) => row.date)).toEqual([
      "2026-11-30",
      "2026-08-30",
      "2026-05-30",
      "2026-02-28",
      "2025-11-30",
      "2025-08-30",
      "2025-05-30",
    ]);
  });

  test("without the saved password a missing one is «sin comprobar», never a warning", () => {
    const rows = myInvestorArrivals(monthly(), {
      ledger: [buy("2026-10-06")],
      readOn: "2026-11-20",
      savedPassword: false,
      today: "2026-11-20",
    });
    expect(rows[1]?.status).toBe("unchecked");
    expect(myInvestorMissingArrivals(rows)).toEqual([]);
  });

  test("an order matches one occurrence only, and a traspaso or an apertura matches none", () => {
    const rows = myInvestorArrivals(monthly(), {
      ledger: [
        { ...buy("2026-10-06", "t"), kind: "transfer_in", transferId: "x" },
        { ...buy("2026-11-05", "o"), source: "opening" },
      ],
      readOn: "2026-11-20",
      savedPassword: true,
      today: "2026-11-20",
    });
    expect(rows[1]?.status).toBe("missing");
    expect(rows[2]?.status).toBe("missing");
  });

  test("only what went missing after the last one that arrived is warned about", () => {
    const rows = myInvestorArrivals(monthly(), {
      // August missing long ago; September arrived; October and November missing.
      ledger: [buy("2026-07-06"), buy("2026-09-07")],
      readOn: "2026-11-20",
      savedPassword: true,
      today: "2026-11-20",
    });
    expect(myInvestorMissingArrivals(rows).map((row) => row.date)).toEqual([
      "2026-11-05",
      "2026-10-05",
    ]);
  });

  test("a cancelled schedule lists what it scheduled and nothing to come", () => {
    const rows = myInvestorArrivals(
      schedule({
        status: "CANCELED",
        timeFrame: {
          endDate: null,
          nextExecutionDate: "2025-06-05",
          recurrence: "ONE_MONTH",
          startDate: "2025-03-05",
        },
      }),
      {
        ledger: [buy("2025-03-05"), buy("2025-04-07"), buy("2025-05-05")],
        readOn: "2026-11-20",
        savedPassword: true,
        today: "2026-11-20",
      },
    );
    expect(rows.map((row) => [row.date, row.status])).toEqual([
      ["2025-05-05", "arrived"],
      ["2025-04-05", "arrived"],
      ["2025-03-05", "arrived"],
    ]);
  });

  test("keeps the most recent occurrences only", () => {
    const rows = myInvestorArrivals(monthly(), {
      ledger: [],
      limit: 3,
      readOn: "2026-11-20",
      savedPassword: true,
      today: "2026-11-20",
    });
    expect(rows.map((row) => row.date)).toEqual([
      "2026-12-05",
      "2026-11-05",
      "2026-10-05",
      "2026-09-05",
    ]);
  });
});

describe("myInvestorWaitingEntries", () => {
  test("one already due whose order is still on its way, flagged for the forecast", () => {
    expect(
      myInvestorWaitingEntries([schedule()], {
        ledger: [buy("2026-10-06")],
        readOn: "2026-11-09",
        today: "2026-11-09",
      }),
    ).toEqual([
      {
        amountMinor: 8_743,
        dateISO: "2026-11-05",
        holdingId: "pp",
        origin: "source",
        pendingArrival: true,
      },
    ]);
  });
});

describe("myInvestorScheduledEntries", () => {
  test("an active schedule's occurrences in the range, in money, as the source's", () => {
    expect(
      myInvestorScheduledEntries([monthlySchedule()], {
        from: "2026-11-21",
        to: "2026-12-31",
      }),
    ).toEqual([
      { amountMinor: 8_743, dateISO: "2026-12-05", holdingId: "pp", origin: "source" },
    ]);
  });

  test("a cancelled one schedules nothing more", () => {
    expect(
      myInvestorScheduledEntries(
        [
          schedule({
            status: "CANCELED",
            timeFrame: {
              endDate: null,
              nextExecutionDate: "2026-12-05",
              recurrence: "ONE_MONTH",
              startDate: "2025-03-05",
            },
          }),
        ],
        { from: "2026-11-21", to: "2026-12-31" },
      ),
    ).toEqual([]);
  });

  function monthlySchedule() {
    return schedule();
  }
});
