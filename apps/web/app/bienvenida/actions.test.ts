import { beforeEach, describe, expect, test, vi } from "vitest";

const { markOnboardedBestEffort, guardDemoWrite, isWriteBlocked } = vi.hoisted(() => ({
  markOnboardedBestEffort: vi.fn(async () => undefined),
  guardDemoWrite: vi.fn(async () => undefined),
  isWriteBlocked: vi.fn(async () => false),
}));
vi.mock("@web/activation-marks", () => ({ markOnboardedBestEffort }));
vi.mock("@web/demo/write-guard", () => ({ guardDemoWrite, isWriteBlocked }));

import { markOnboardingCompleteAction, skipOnboardingAction } from "./actions";

/** Invoke the action (which always throws redirect()) and return the URL digest. */
async function runRedirect(action: () => Promise<never>): Promise<string> {
  try {
    await action();
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

beforeEach(() => {
  markOnboardedBestEffort.mockClear();
  guardDemoWrite.mockClear();
  isWriteBlocked.mockClear();
  isWriteBlocked.mockResolvedValue(false);
});

describe("skipOnboardingAction (#1168)", () => {
  test("stamps onboarded and drops onto the dashboard", async () => {
    const url = await runRedirect(skipOnboardingAction);

    expect(markOnboardedBestEffort).toHaveBeenCalledOnce();
    expect(url).toContain("/app");
  });

  test("runs the demo/impersonation write guard before stamping (#1180)", async () => {
    // The mark is a control-plane write on the RESOLVED workspace, so an
    // impersonating admin would otherwise stamp someone else's onboarding.
    guardDemoWrite.mockImplementationOnce(async () => {
      throw new Error("blocked");
    });

    await expect(skipOnboardingAction()).rejects.toThrow("blocked");
    expect(guardDemoWrite).toHaveBeenCalledWith("/bienvenida");
    expect(markOnboardedBestEffort).not.toHaveBeenCalled();
  });
});

describe("markOnboardingCompleteAction (#1169)", () => {
  test("stamps onboarded when the first proposal is confirmed, without redirecting", async () => {
    // Unlike the skip, this runs mid-conversation: it must NOT navigate away.
    await expect(markOnboardingCompleteAction()).resolves.toBeUndefined();

    expect(markOnboardedBestEffort).toHaveBeenCalledOnce();
  });

  test("refuses silently for a blocked write, without redirecting (#1180)", async () => {
    // Fired from the client mid-conversation: a redirect would be wrong, so the
    // guard is the non-throwing `isWriteBlocked` and the action just no-ops.
    isWriteBlocked.mockResolvedValue(true);

    await expect(markOnboardingCompleteAction()).resolves.toBeUndefined();

    expect(markOnboardedBestEffort).not.toHaveBeenCalled();
  });
});
