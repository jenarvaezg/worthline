import { describe, expect, it } from "vitest";

import {
  acquisitionDatedToday,
  acquisitionTodayNotice,
  type DebtHistoryFloor,
} from "./housing-acquisition-notice";

const TODAY = "2026-08-26";

/** A mortgage whose own curve reaches back to 2004 — the Plasencia case (#1436). */
const MORTGAGE_2004: DebtHistoryFloor = {
  liabilityId: "hipoteca",
  startDate: "2004-05-19",
};

describe("acquisitionDatedToday — the gate that decides whether to look at all", () => {
  it("is true when the alta stamps today (what the simple drawer always does)", () => {
    expect(acquisitionDatedToday({ acquisitionDate: TODAY, today: TODAY })).toBe(true);
  });

  it("is false for a historical acquisition date", () => {
    expect(acquisitionDatedToday({ acquisitionDate: "2004-05-19", today: TODAY })).toBe(
      false,
    );
  });

  it("is false when the alta declares no acquisition date at all", () => {
    expect(acquisitionDatedToday({ acquisitionDate: undefined, today: TODAY })).toBe(
      false,
    );
  });
});

describe("acquisitionTodayNotice — #1561", () => {
  it("warns when the acquisition is dated today and a debt already starts earlier", () => {
    expect(
      acquisitionTodayNotice({
        acquisitionDate: TODAY,
        debtFloors: [MORTGAGE_2004],
        today: TODAY,
      }),
    ).toEqual({ earliestDebtStart: "2004-05-19" });
  });

  it("names the EARLIEST prior debt when several predate the acquisition", () => {
    expect(
      acquisitionTodayNotice({
        acquisitionDate: TODAY,
        debtFloors: [
          { liabilityId: "coche", startDate: "2020-03-01" },
          MORTGAGE_2004,
          { liabilityId: "reforma", startDate: "2019-01-01" },
        ],
        today: TODAY,
      }),
    ).toEqual({ earliestDebtStart: "2004-05-19" });
  });

  it("stays silent for a historical acquisition date, prior debt or not", () => {
    expect(
      acquisitionTodayNotice({
        acquisitionDate: "2004-06-01",
        debtFloors: [MORTGAGE_2004],
        today: TODAY,
      }),
    ).toBeNull();
  });

  it("stays silent when no debt predates the acquisition", () => {
    expect(
      acquisitionTodayNotice({
        acquisitionDate: TODAY,
        debtFloors: [{ liabilityId: "prestamo", startDate: TODAY }],
        today: TODAY,
      }),
    ).toBeNull();
  });

  it("stays silent with no debts at all", () => {
    expect(
      acquisitionTodayNotice({ acquisitionDate: TODAY, debtFloors: [], today: TODAY }),
    ).toBeNull();
  });

  it("stays silent when the alta declares no acquisition date", () => {
    expect(
      acquisitionTodayNotice({
        acquisitionDate: undefined,
        debtFloors: [MORTGAGE_2004],
        today: TODAY,
      }),
    ).toBeNull();
  });
});
