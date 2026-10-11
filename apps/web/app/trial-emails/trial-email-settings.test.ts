import { describe, expect, test } from "vitest";

import { trialEmailSettingsFromEnv } from "./trial-email-settings";

const SITE = "https://worthline.example";
const READY = {
  AUTH_SECRET: "auth-secret",
  RESEND_API_KEY: "re_test",
  WORTHLINE_EMAIL_FROM: "worthline <avisos@example.com>",
};

describe("trial email settings (#1173)", () => {
  test("ready with a Resend key, a verified sender and the signing secret", () => {
    expect(trialEmailSettingsFromEnv(READY, SITE)).toEqual({
      settings: {
        email: { apiKey: "re_test", from: "worthline <avisos@example.com>" },
        optOutSecret: "auth-secret",
        replyTo: null,
        siteUrl: SITE,
      },
      status: "ready",
    });
  });

  test("replies go to the published contact address when there is one", () => {
    const resolved = trialEmailSettingsFromEnv(
      { ...READY, WORTHLINE_LEGAL_CONTACT_EMAIL: " hola@example.com " },
      SITE,
    );
    expect(resolved.status === "ready" && resolved.settings.replyTo).toBe(
      "hola@example.com",
    );
  });

  test("without an explicit sender it is NOT ready: the sandbox sender only reaches the account owner", () => {
    expect(
      trialEmailSettingsFromEnv({ ...READY, WORTHLINE_EMAIL_FROM: " " }, SITE),
    ).toEqual({
      missing: ["WORTHLINE_EMAIL_FROM"],
      status: "not_configured",
    });
    expect(
      trialEmailSettingsFromEnv(
        { ...READY, WORTHLINE_EMAIL_FROM: "worthline <onboarding@resend.dev>" },
        SITE,
      ),
    ).toEqual({ missing: ["WORTHLINE_EMAIL_FROM"], status: "not_configured" });
  });

  test("the sandbox is recognized by its domain whatever the display name, and a sender with no domain is no sender", () => {
    for (const from of ["Otro nombre <ONBOARDING@Resend.dev>", "worthline"]) {
      expect(
        trialEmailSettingsFromEnv({ ...READY, WORTHLINE_EMAIL_FROM: from }, SITE),
      ).toEqual({
        missing: ["WORTHLINE_EMAIL_FROM"],
        status: "not_configured",
      });
    }
    expect(
      trialEmailSettingsFromEnv(
        { ...READY, WORTHLINE_EMAIL_FROM: "avisos@example.com" },
        SITE,
      ).status,
    ).toBe("ready");
  });

  test("names everything missing at once, so one log line says what to set", () => {
    expect(trialEmailSettingsFromEnv({}, SITE)).toEqual({
      missing: ["RESEND_API_KEY", "WORTHLINE_EMAIL_FROM", "AUTH_SECRET"],
      status: "not_configured",
    });
  });
});
