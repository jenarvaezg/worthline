import { describe, expect, test } from "vitest";

import {
  type OwningSourceAttempt,
  type OwningSourceHealthFacts,
  owningSourceDataKind,
  owningSourceHealth,
  owningSourceStop,
} from "./owning-source-health";

const failedAt = (day: string, step: string): OwningSourceAttempt => ({
  at: `${day}T07:13:00.000Z`,
  failedStep: step,
  status: "error",
});
const goodAt = (day: string): OwningSourceAttempt => ({
  at: `${day}T07:13:00.000Z`,
  failedStep: null,
  status: "ok",
});

function facts(
  overrides: Partial<OwningSourceHealthFacts> = {},
): OwningSourceHealthFacts {
  return {
    attempts: [],
    lastSyncAt: "2026-10-29T07:13:00.000Z",
    savedPassword: true,
    stop: null,
    ...overrides,
  };
}

describe("«El conector falla», by kind of data, after three days in a row", () => {
  test("two days failing on the orders say nothing yet", () => {
    const attempts = [failedAt("2026-11-03", "orders"), failedAt("2026-11-02", "orders")];

    expect(owningSourceHealth(facts({ attempts }), "2026-11-03")).toEqual([]);
  });

  test("three days in a row failing on the orders say so, from the first of them", () => {
    const attempts = [
      failedAt("2026-11-03", "orders"),
      failedAt("2026-11-02", "orders"),
      failedAt("2026-11-01", "orders"),
      goodAt("2026-10-31"),
    ];

    expect(owningSourceHealth(facts({ attempts }), "2026-11-03")).toEqual([
      { data: "orders", days: 3, kind: "failing", since: "2026-11-01" },
    ]);
  });

  test("a good day in between starts the count again", () => {
    const attempts = [
      failedAt("2026-11-04", "orders"),
      failedAt("2026-11-03", "orders"),
      goodAt("2026-11-02"),
      failedAt("2026-11-01", "orders"),
      failedAt("2026-10-31", "orders"),
    ];

    expect(owningSourceHealth(facts({ attempts }), "2026-11-04")).toEqual([]);
  });

  test("a pass that failed AFTER the orders read them: the plans fail, the orders do not", () => {
    const attempts = [
      failedAt("2026-11-03", "contributions"),
      failedAt("2026-11-02", "plans"),
      failedAt("2026-11-01", "plans"),
    ];

    expect(owningSourceHealth(facts({ attempts }), "2026-11-03")).toEqual([
      { data: "plans", days: 3, kind: "failing", since: "2026-11-01" },
    ]);
  });

  test("a pass that never reached the data (the login) neither counts nor resets", () => {
    const attempts = [
      failedAt("2026-11-05", "orders"),
      failedAt("2026-11-04", "login"),
      failedAt("2026-11-03", "orders"),
    ];

    expect(owningSourceHealth(facts({ attempts }), "2026-11-05")).toEqual([
      { data: "orders", days: 3, kind: "failing", since: "2026-11-03" },
    ]);
  });

  test("the positions failing is said of the positions, the cash read with them", () => {
    const attempts = [
      failedAt("2026-11-03", "cash"),
      failedAt("2026-11-02", "positions"),
      failedAt("2026-11-01", "positions"),
    ];

    expect(owningSourceHealth(facts({ attempts }), "2026-11-03")).toEqual([
      { data: "positions", days: 3, kind: "failing", since: "2026-11-01" },
    ]);
  });

  test("a pass still running says nothing about how the last one ended", () => {
    const attempts: OwningSourceAttempt[] = [
      { at: "2026-11-03T08:00:00.000Z", failedStep: null, status: "running" },
      failedAt("2026-11-03", "orders"),
      failedAt("2026-11-02", "orders"),
      failedAt("2026-11-01", "orders"),
    ];

    expect(owningSourceHealth(facts({ attempts }), "2026-11-03")).toHaveLength(1);
  });
});

describe("with no saved password, a soft reminder at 45 days", () => {
  const manual = { savedPassword: false };

  test("44 days without a good sync: nothing yet", () => {
    expect(
      owningSourceHealth(
        facts({ ...manual, lastSyncAt: "2026-09-21T18:02:00.000Z" }),
        "2026-11-04",
      ),
    ).toEqual([]);
  });

  test("45 days: the reminder", () => {
    expect(
      owningSourceHealth(
        facts({ ...manual, lastSyncAt: "2026-09-20T18:02:00.000Z" }),
        "2026-11-04",
      ),
    ).toEqual([{ days: 45, kind: "unsynced" }]);
  });

  test("with the password saved the daily sync runs, and no reminder is due", () => {
    expect(
      owningSourceHealth(facts({ lastSyncAt: "2026-07-01T18:02:00.000Z" }), "2026-11-04"),
    ).toEqual([]);
  });

  test("a stop is said once, as the stop: no reminder on top of it", () => {
    expect(
      owningSourceHealth(
        facts({
          ...manual,
          lastSyncAt: "2026-07-01T18:02:00.000Z",
          stop: "password_forgotten",
        }),
        "2026-11-04",
      ),
    ).toEqual([{ kind: "stop", stop: "password_forgotten" }]);
  });

  test("never synced: nothing to measure the 45 days from", () => {
    expect(
      owningSourceHealth(facts({ ...manual, lastSyncAt: null }), "2026-11-04"),
    ).toEqual([]);
  });
});

describe("the stop of the periodic sync", () => {
  test("the SMS, while the stop holds", () => {
    expect(
      owningSourceStop({
        lastOutcome: { forgotten: null, kind: "sms_required" },
        savedPassword: true,
        stoppedReason: "sms_required",
      }),
    ).toBe("sms_required");
  });

  test("a saved password MyInvestor rejected, until another one is saved", () => {
    const rejected = { forgotten: true, kind: "password_rejected" };
    expect(
      owningSourceStop({
        lastOutcome: rejected,
        savedPassword: false,
        stoppedReason: null,
      }),
    ).toBe("password_forgotten");
    expect(
      owningSourceStop({
        lastOutcome: rejected,
        savedPassword: true,
        stoppedReason: null,
      }),
    ).toBeNull();
  });

  test("a typed password rejected deletes nothing, and stops nothing", () => {
    expect(
      owningSourceStop({
        lastOutcome: { forgotten: false, kind: "password_rejected" },
        savedPassword: false,
        stoppedReason: null,
      }),
    ).toBeNull();
  });
});

test("the kind of data of each step the client names", () => {
  expect(
    [
      "login",
      "refresh",
      "sms",
      "cash",
      "positions",
      "orders",
      "plans",
      "contributions",
    ].map(owningSourceDataKind),
  ).toEqual([null, null, null, "positions", "positions", "orders", "plans", "plans"]);
  expect(owningSourceDataKind(null)).toBeNull();
});
