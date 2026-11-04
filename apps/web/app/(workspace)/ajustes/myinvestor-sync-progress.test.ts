/** The pending «Poner al día» (#1884): its own pass's steps, or the wait for another's. */
import { describe, expect, test } from "vitest";

import { myInvestorProgressView, myInvestorStepStates } from "./myinvestor-sync-progress";

const NOW = "2026-11-04T11:04:01.000Z";
const PRESSED = Date.parse("2026-11-04T11:04:00.000Z");

describe("the pending press", () => {
  test("before the first poll answers, the first step", () => {
    expect(myInvestorProgressView(null, PRESSED)).toEqual({ current: 0, kind: "steps" });
  });

  test("its own pass, on the step it wrote down", () => {
    expect(
      myInvestorProgressView(
        {
          now: NOW,
          running: true,
          startedAt: "2026-11-04T11:04:00.300Z",
          step: "orders",
        },
        PRESSED,
      ),
    ).toEqual({ current: 2, kind: "steps" });
  });

  test("a pass that started before the press is waited for", () => {
    expect(
      myInvestorProgressView(
        { now: NOW, running: true, startedAt: "2026-11-04T06:10:00.000Z", step: "plans" },
        PRESSED,
      ),
    ).toEqual({ kind: "waiting", startedAt: "2026-11-04T06:10:00.000Z" });
  });

  test("a client clock ahead does not pass its own pass off as another's", () => {
    // The client reads 11:04:03 when the server reads 11:04:00.
    const clientPressed = PRESSED + 3_000;
    expect(
      myInvestorProgressView(
        { now: NOW, running: true, startedAt: "2026-11-04T11:04:00.300Z", step: "login" },
        clientPressed,
        -3_000,
      ),
    ).toEqual({ current: 0, kind: "steps" });
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
