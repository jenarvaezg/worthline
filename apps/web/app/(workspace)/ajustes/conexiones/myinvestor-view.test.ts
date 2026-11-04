import {
  MYINVESTOR_PREMIUM_LINE,
  MYINVESTOR_READ_ONLY_LINE,
  MYINVESTOR_UNAVAILABLE_LINE,
} from "@web/ajustes/myinvestor-copy";
import { describe, expect, test } from "vitest";
import {
  myInvestorAvailability,
  myInvestorCodeDeadline,
  myInvestorPasswordAcceptedBy,
} from "./myinvestor-view";

describe("myInvestorAvailability — what the «Sin conectar» row offers", () => {
  test("the fold, only with the relay, write access and premium", () => {
    expect(
      myInvestorAvailability({ premium: true, readOnly: false, relayConfigured: true }),
    ).toEqual({ kind: "connect" });
  });

  test("otherwise one line saying why, the relay first: nobody can fix it from here", () => {
    expect(
      myInvestorAvailability({ premium: false, readOnly: true, relayConfigured: false }),
    ).toEqual({ kind: "line", text: MYINVESTOR_UNAVAILABLE_LINE });
    expect(
      myInvestorAvailability({ premium: false, readOnly: true, relayConfigured: true }),
    ).toEqual({ kind: "line", text: MYINVESTOR_READ_ONLY_LINE });
    expect(
      myInvestorAvailability({ premium: false, readOnly: false, relayConfigured: true }),
    ).toEqual({ kind: "premium", text: MYINVESTOR_PREMIUM_LINE });
  });
});

describe("myInvestorCodeDeadline — until what time the code counts", () => {
  test("is the clock time, not a countdown", () => {
    expect(myInvestorCodeDeadline("2026-11-04T11:05:00.000Z", "Europe/Madrid")).toBe(
      "12:05",
    );
  });
});

describe("myInvestorPasswordAcceptedBy — who accepted the risk", () => {
  test("«tú» for the session that accepted it, or when there is no session at all", () => {
    expect(
      myInvestorPasswordAcceptedBy("titular@example.com", "titular@example.com"),
    ).toBe("La aceptaste tú.");
    expect(myInvestorPasswordAcceptedBy(null, null)).toBe("La aceptaste tú.");
  });

  test("the address of whoever else accepted it", () => {
    expect(myInvestorPasswordAcceptedBy("titular@example.com", "leo@example.com")).toBe(
      "La aceptó titular@example.com.",
    );
  });
});
