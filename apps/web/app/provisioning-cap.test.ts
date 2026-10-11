import { describe, expect, test } from "vitest";

import {
  DAILY_PROVISIONING_CAP_ENV,
  PROVISIONING_CLOSED_LOGIN_PATH,
  readDailyProvisioningCap,
} from "./provisioning-cap";

// Illustrative values only: the real cap lives in the deployment's env.
const PRODUCTION = { VERCEL_ENV: "production" };

describe("readDailyProvisioningCap (#1175)", () => {
  test("names its env var and the page a refused sign-up lands on", () => {
    expect(DAILY_PROVISIONING_CAP_ENV).toBe("WORTHLINE_DAILY_PROVISIONING_CAP");
    expect(PROVISIONING_CLOSED_LOGIN_PATH).toBe("/login?registro=lleno");
  });

  test("outside production, unset or blank means no cap (local, e2e, self-host)", () => {
    for (const env of [
      {},
      { [DAILY_PROVISIONING_CAP_ENV]: "" },
      { [DAILY_PROVISIONING_CAP_ENV]: "   " },
      { VERCEL_ENV: "preview" },
    ]) {
      expect(readDailyProvisioningCap(env)).toEqual({ kind: "uncapped" });
    }
  });

  test("in a production deploy, a forgotten variable closes new sign-ups like a typo would", () => {
    expect(readDailyProvisioningCap(PRODUCTION)).toEqual({ kind: "unset" });
    expect(
      readDailyProvisioningCap({ ...PRODUCTION, [DAILY_PROVISIONING_CAP_ENV]: " " }),
    ).toEqual({ kind: "unset" });
  });

  test("a non-negative integer is the limit, in production or not; zero closes registration", () => {
    expect(readDailyProvisioningCap({ [DAILY_PROVISIONING_CAP_ENV]: "3" })).toEqual({
      kind: "limited",
      limit: 3,
    });
    expect(
      readDailyProvisioningCap({ ...PRODUCTION, [DAILY_PROVISIONING_CAP_ENV]: " 12 " }),
    ).toEqual({ kind: "limited", limit: 12 });
    expect(readDailyProvisioningCap({ [DAILY_PROVISIONING_CAP_ENV]: "0" })).toEqual({
      kind: "limited",
      limit: 0,
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
    "99999999999999999999",
  ])("%j is a misconfiguration, never silently read as a number", (raw) => {
    for (const env of [{}, PRODUCTION]) {
      expect(
        readDailyProvisioningCap({ ...env, [DAILY_PROVISIONING_CAP_ENV]: raw }),
      ).toEqual({ configuredValue: raw, kind: "misconfigured" });
    }
  });
});
