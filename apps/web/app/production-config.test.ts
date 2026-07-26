import { describe, expect, it } from "vitest";

import { assertProductionConfigured, bootRefusals } from "./production-config";

/** A fully configured hosted deployment, as the Vercel Production scope sets it. */
const CONFIGURED_PRODUCTION: Record<string, string> = {
  VERCEL_ENV: "production",
  AUTH_GOOGLE_ID: "id",
  AUTH_GOOGLE_SECRET: "secret",
  AUTH_SECRET: "a-long-random-string",
  WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://wl-control-plane.turso.io",
  WORTHLINE_DB_AUTH_TOKEN: "group-token",
  TURSO_ORG: "worthline",
  TURSO_API_TOKEN: "platform-token",
};

/** The env the CI e2e suite boots `next start` with (see `playwright.config.ts`):
 * NODE_ENV=production, both Google vars deliberately BLANK, a throwaway
 * AUTH_SECRET, and a file-backed control plane. It must keep booting. */
const E2E_PRODUCTION_BUILD: Record<string, string> = {
  NODE_ENV: "production",
  AUTH_GOOGLE_ID: "",
  AUTH_GOOGLE_SECRET: "",
  AUTH_SECRET: "worthline-e2e-test-secret-not-for-production",
  WORTHLINE_CONTROL_PLANE_DB_URL: "file:/tmp/worthline-e2e/control-plane.sqlite",
};

describe("bootRefusals", () => {
  it("refuses nothing in local no-auth mode (no env at all)", () => {
    expect(bootRefusals({})).toEqual([]);
  });

  it("refuses nothing for a NODE_ENV=production run off Vercel (self-hosted, e2e)", () => {
    expect(bootRefusals(E2E_PRODUCTION_BUILD)).toEqual([]);
  });

  it("refuses nothing for a preview deploy (deliberately out of scope)", () => {
    expect(bootRefusals({ VERCEL_ENV: "preview" })).toEqual([]);
  });

  it("refuses nothing when the production deploy is fully configured", () => {
    expect(bootRefusals(CONFIGURED_PRODUCTION)).toEqual([]);
  });

  it("names every missing var at once in a production deploy", () => {
    const [refusal, ...rest] = bootRefusals({ VERCEL_ENV: "production" });

    expect(rest).toEqual([]);
    for (const name of [
      "AUTH_GOOGLE_ID",
      "AUTH_GOOGLE_SECRET",
      "AUTH_SECRET",
      "WORTHLINE_CONTROL_PLANE_DB_URL",
      "WORTHLINE_DB_AUTH_TOKEN",
      "TURSO_ORG",
      "TURSO_API_TOKEN",
    ]) {
      expect(refusal).toContain(name);
    }
  });

  it("treats a blank or whitespace-only value as missing", () => {
    const [refusal] = bootRefusals({
      ...CONFIGURED_PRODUCTION,
      AUTH_SECRET: "",
      WORTHLINE_DB_AUTH_TOKEN: "   ",
    });

    expect(refusal).toContain("AUTH_SECRET, WORTHLINE_DB_AUTH_TOKEN");
    // Vars that ARE set must not be blamed — the operator has to know what to fix.
    expect(refusal).not.toContain("TURSO_ORG");
  });

  it("refuses a half-configured Google pair even off Vercel", () => {
    const refusals = bootRefusals({
      ...E2E_PRODUCTION_BUILD,
      AUTH_GOOGLE_ID: "id",
    });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("only one of AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET");
  });

  it("reports both problems when a production deploy is also half-configured", () => {
    expect(
      bootRefusals({ VERCEL_ENV: "production", AUTH_GOOGLE_SECRET: "secret" }),
    ).toHaveLength(2);
  });
});

describe("assertProductionConfigured", () => {
  it("throws in a production deploy missing the auth config, naming every gap", () => {
    expect(() =>
      assertProductionConfigured({
        ...CONFIGURED_PRODUCTION,
        AUTH_GOOGLE_ID: undefined,
        AUTH_GOOGLE_SECRET: undefined,
      }),
    ).toThrow(/AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET/);
  });

  it("throws in a production deploy missing the control plane", () => {
    expect(() =>
      assertProductionConfigured({
        ...CONFIGURED_PRODUCTION,
        WORTHLINE_CONTROL_PLANE_DB_URL: undefined,
      }),
    ).toThrow(/WORTHLINE_CONTROL_PLANE_DB_URL/);
  });

  it("throws in a production deploy that cannot provision workspaces", () => {
    expect(() =>
      assertProductionConfigured({
        ...CONFIGURED_PRODUCTION,
        TURSO_API_TOKEN: undefined,
      }),
    ).toThrow(/TURSO_API_TOKEN/);
  });

  it("passes in a fully configured production deploy", () => {
    expect(() => assertProductionConfigured(CONFIGURED_PRODUCTION)).not.toThrow();
  });

  it("is a no-op in local no-auth mode and for the e2e production build", () => {
    expect(() => assertProductionConfigured({})).not.toThrow();
    expect(() => assertProductionConfigured(E2E_PRODUCTION_BUILD)).not.toThrow();
  });
});
