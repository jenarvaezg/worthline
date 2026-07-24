import { describe, expect, test, vi } from "vitest";

const { markOnboardedBestEffort } = vi.hoisted(() => ({
  markOnboardedBestEffort: vi.fn(async () => undefined),
}));
vi.mock("@web/activation-marks", () => ({ markOnboardedBestEffort }));

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

describe("skipOnboardingAction (#1168)", () => {
  test("stamps onboarded and drops onto the dashboard", async () => {
    markOnboardedBestEffort.mockClear();

    const url = await runRedirect(skipOnboardingAction);

    expect(markOnboardedBestEffort).toHaveBeenCalledOnce();
    expect(url).toContain("/app");
  });
});

describe("markOnboardingCompleteAction (#1169)", () => {
  test("stamps onboarded when the first proposal is confirmed, without redirecting", async () => {
    markOnboardedBestEffort.mockClear();

    // Unlike the skip, this runs mid-conversation: it must NOT navigate away.
    await expect(markOnboardingCompleteAction()).resolves.toBeUndefined();

    expect(markOnboardedBestEffort).toHaveBeenCalledOnce();
  });
});
