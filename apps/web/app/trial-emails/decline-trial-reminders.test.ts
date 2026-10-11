import { describe, expect, test, vi } from "vitest";

import {
  DECLINE_INVALID_LINK,
  DECLINE_UNAVAILABLE,
  declineTrialReminders,
} from "./decline-trial-reminders";
import { signReminderOptOutToken } from "./reminder-opt-out-token";

const SECRET = "test-secret";
const NOW = "2026-10-02T08:00:00.000Z";

function deps(overrides: Partial<Parameters<typeof declineTrialReminders>[1]> = {}) {
  return {
    log: { error: vi.fn() },
    now: NOW,
    record: vi.fn(async () => true),
    secret: SECRET,
    ...overrides,
  };
}

describe("declining the trial reminders from the email link (#1173)", () => {
  test("records the opt-out for the identity the link was signed for", async () => {
    const d = deps();
    const state = await declineTrialReminders(
      signReminderOptOutToken("user-1", SECRET),
      d,
    );

    expect(state).toEqual({ status: "done" });
    expect(d.record).toHaveBeenCalledWith("user-1", NOW);
  });

  test("a forged or broken link records nothing and says so", async () => {
    const d = deps();
    const forged = signReminderOptOutToken("user-1", "someone-elses-secret");

    expect(await declineTrialReminders(forged, d)).toEqual({
      error: DECLINE_INVALID_LINK,
      status: "error",
    });
    expect(await declineTrialReminders(null, d)).toEqual({
      error: DECLINE_INVALID_LINK,
      status: "error",
    });
    expect(d.record).not.toHaveBeenCalled();
  });

  test("with no signing secret no link can be trusted", async () => {
    const d = deps({ secret: null });
    expect(
      await declineTrialReminders(signReminderOptOutToken("user-1", SECRET), d),
    ).toEqual({
      error: DECLINE_INVALID_LINK,
      status: "error",
    });
  });

  test("a write that could not land is reported, not faked as done", async () => {
    const noControlPlane = deps({ record: vi.fn(async () => false) });
    expect(
      await declineTrialReminders(
        signReminderOptOutToken("user-1", SECRET),
        noControlPlane,
      ),
    ).toEqual({ error: DECLINE_UNAVAILABLE, status: "error" });

    const failing = deps({
      record: vi.fn(async () => {
        throw new Error("control plane down");
      }),
    });
    expect(
      await declineTrialReminders(signReminderOptOutToken("user-1", SECRET), failing),
    ).toEqual({ error: DECLINE_UNAVAILABLE, status: "error" });
    expect(failing.log.error).toHaveBeenCalledOnce();
  });
});
