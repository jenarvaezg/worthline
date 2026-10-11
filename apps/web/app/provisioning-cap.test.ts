import { describe, expect, test } from "vitest";

import {
  DAILY_PROVISIONING_CAP_ENV,
  effectiveDailyProvisioningCap,
  readDailyProvisioningCap,
} from "./provisioning-cap";

// Illustrative values only: the real cap lives in the deployment's env.
describe("readDailyProvisioningCap (#1175)", () => {
  test("names its env var", () => {
    expect(DAILY_PROVISIONING_CAP_ENV).toBe("WORTHLINE_DAILY_PROVISIONING_CAP");
  });

  test("unset or blank means no cap: registration stays open (#733)", () => {
    expect(readDailyProvisioningCap({})).toEqual({ kind: "uncapped" });
    expect(readDailyProvisioningCap({ [DAILY_PROVISIONING_CAP_ENV]: "" })).toEqual({
      kind: "uncapped",
    });
    expect(readDailyProvisioningCap({ [DAILY_PROVISIONING_CAP_ENV]: "   " })).toEqual({
      kind: "uncapped",
    });
  });

  test("a non-negative integer is the cap, and zero closes registration", () => {
    expect(readDailyProvisioningCap({ [DAILY_PROVISIONING_CAP_ENV]: "3" })).toEqual({
      cap: 3,
      kind: "capped",
    });
    expect(readDailyProvisioningCap({ [DAILY_PROVISIONING_CAP_ENV]: " 12 " })).toEqual({
      cap: 12,
      kind: "capped",
    });
    expect(readDailyProvisioningCap({ [DAILY_PROVISIONING_CAP_ENV]: "0" })).toEqual({
      cap: 0,
      kind: "capped",
    });
  });

  test.each([
    "-1",
    "2.5",
    "abc",
    "1e3",
    "10abc",
    "0x10",
    "Infinity",
    "1_000",
  ])("%j is a misconfiguration, never silently read as a number", (raw) => {
    expect(readDailyProvisioningCap({ [DAILY_PROVISIONING_CAP_ENV]: raw })).toEqual({
      kind: "misconfigured",
      raw,
    });
  });
});

describe("effectiveDailyProvisioningCap (#1175)", () => {
  test("no cap stays no cap", () => {
    expect(effectiveDailyProvisioningCap({ kind: "uncapped" })).toBeNull();
  });

  test("a configured cap is used as is", () => {
    expect(effectiveDailyProvisioningCap({ cap: 4, kind: "capped" })).toBe(4);
  });

  test("a misconfigured cap fails CLOSED for new sign-ups only", () => {
    // The operator meant to set a fuse; a typo must not silently remove it.
    // Existing users are unaffected — the provisioner resolves them first.
    expect(effectiveDailyProvisioningCap({ kind: "misconfigured", raw: "cinco" })).toBe(
      0,
    );
  });
});
