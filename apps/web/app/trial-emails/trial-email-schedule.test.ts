import { describe, expect, test } from "vitest";

import type { TrialEmailCandidate } from "./trial-email-candidates";
import { dueTrialEmail, TRIAL_EMAIL_CUTOFF_MS } from "./trial-email-schedule";

// A 3-day trial that started on the 1st at 10:00 UTC and closes on the 4th.
const candidate = (
  overrides: Partial<TrialEmailCandidate> = {},
): TrialEmailCandidate => ({
  claimedKinds: [],
  email: "ana@example.com",
  plan: "trial",
  premiumUntil: null,
  remindersOptedOutAt: null,
  trialEndsAt: "2026-10-04T10:00:00.000Z",
  userId: "user-1",
  workspaceId: "ws-1",
  ...overrides,
});

describe("dueTrialEmail (#1173)", () => {
  test("during the first day the only email is the welcome (a retry, if provisioning's send failed)", () => {
    expect(dueTrialEmail(candidate(), "2026-10-01T21:00:00.000Z")).toBe("welcome");
    expect(
      dueTrialEmail(candidate({ claimedKinds: ["welcome"] }), "2026-10-01T21:00:00.000Z"),
    ).toBeNull();
  });

  test("from day 2 the reminder is due, and a welcome that never went out stays unsent", () => {
    expect(dueTrialEmail(candidate(), "2026-10-02T21:00:00.000Z")).toBe("trial_reminder");
    expect(
      dueTrialEmail(candidate({ claimedKinds: ["welcome"] }), "2026-10-03T09:00:00.000Z"),
    ).toBe("trial_reminder");
  });

  test("the reminder goes out once", () => {
    expect(
      dueTrialEmail(
        candidate({ claimedKinds: ["welcome", "trial_reminder"] }),
        "2026-10-03T21:00:00.000Z",
      ),
    ).toBeNull();
  });

  test("the reminder window closes 12 h before the end: no «termina el X» on day X itself", () => {
    expect(dueTrialEmail(candidate(), "2026-10-03T21:59:59.000Z")).toBe("trial_reminder");
    expect(dueTrialEmail(candidate(), "2026-10-03T22:00:00.000Z")).toBeNull();
    expect(dueTrialEmail(candidate(), "2026-10-04T09:00:00.000Z")).toBeNull();
  });

  test("once the trial closes the expiry notice is due, even if the reminder was missed", () => {
    expect(dueTrialEmail(candidate(), "2026-10-04T21:00:00.000Z")).toBe("trial_expired");
    expect(
      dueTrialEmail(
        candidate({ claimedKinds: ["welcome", "trial_reminder", "trial_expired"] }),
        "2026-10-05T09:00:00.000Z",
      ),
    ).toBeNull();
  });

  test("an expiry too old to be news is never sent (a first deploy, a long outage)", () => {
    expect(dueTrialEmail(candidate(), "2026-10-06T09:59:59.000Z")).toBe("trial_expired");
    expect(dueTrialEmail(candidate(), "2026-10-06T10:00:00.000Z")).toBeNull();
    expect(TRIAL_EMAIL_CUTOFF_MS).toBe(2 * 24 * 60 * 60 * 1000);
  });

  test("«no recibir recordatorios» silences the reminder and the expiry, not the welcome", () => {
    const optedOut = candidate({ remindersOptedOutAt: "2026-10-01T12:00:00.000Z" });
    expect(dueTrialEmail(optedOut, "2026-10-01T21:00:00.000Z")).toBe("welcome");
    expect(dueTrialEmail(optedOut, "2026-10-02T21:00:00.000Z")).toBeNull();
    expect(dueTrialEmail(optedOut, "2026-10-04T21:00:00.000Z")).toBeNull();
  });

  test("a workspace that went premium during the trial hears nothing more about it", () => {
    const paid = candidate({ plan: "premium", premiumUntil: "2026-11-02T10:00:00.000Z" });
    expect(dueTrialEmail(paid, "2026-10-02T21:00:00.000Z")).toBeNull();
    expect(dueTrialEmail(paid, "2026-10-04T21:00:00.000Z")).toBeNull();

    const lifetime = candidate({ plan: "premium", premiumUntil: null });
    expect(dueTrialEmail(lifetime, "2026-10-04T21:00:00.000Z")).toBeNull();
  });
});
