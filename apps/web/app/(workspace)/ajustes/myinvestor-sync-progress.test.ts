/** The pending «Poner al día» (#1884): its own pass's steps, or the wait for another's. */
import { describe, expect, test } from "vitest";

import { myInvestorProgressView, myInvestorStepStates } from "./myinvestor-sync-progress";

const PRESSED = Date.parse("2026-11-04T11:04:00.000Z");

describe("the pending press", () => {
  test("before the first poll answers, the first step", () => {
    expect(myInvestorProgressView(null, PRESSED)).toEqual({ current: 0, kind: "steps" });
  });

  test("its own pass, on the step it wrote down", () => {
    expect(
      myInvestorProgressView(
        { running: true, startedAt: "2026-11-04T11:04:00.300Z", step: "orders" },
        PRESSED,
      ),
    ).toEqual({ current: 2, kind: "steps" });
  });

  test("a pass that started before the press is waited for", () => {
    expect(
      myInvestorProgressView(
        { running: true, startedAt: "2026-11-04T06:10:00.000Z", step: "plans" },
        PRESSED,
      ),
    ).toEqual({ kind: "waiting", startedAt: "2026-11-04T06:10:00.000Z" });
  });

  test("the list marks what is done, what is on and what is left", () => {
    expect(myInvestorStepStates(1).map((step) => step.state)).toEqual([
      "done",
      "now",
      "todo",
      "todo",
      "todo",
    ]);
  });
});
