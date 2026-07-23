import { describe, expect, it } from "vitest";

import {
  dailyTokenBudgetForPlan,
  GLOBAL_DAILY_TOKEN_FUSE,
  isGlobalTokenFuseBlown,
  isWorkspaceTokenBudgetExhausted,
  TRIAL_PREMIUM_DAILY_TOKEN_BUDGET,
  tokenDayWindow,
} from "./token-budget";

describe("tokenDayWindow", () => {
  it("buckets an ISO timestamp by its UTC calendar day", () => {
    expect(tokenDayWindow("2026-07-22T18:59:00.000Z")).toBe("2026-07-22");
    expect(tokenDayWindow("2026-07-22T00:00:00.000Z")).toBe("2026-07-22");
  });
});

describe("dailyTokenBudgetForPlan", () => {
  it("gives the paid plans the generous daily budget", () => {
    expect(dailyTokenBudgetForPlan("trial")).toBe(TRIAL_PREMIUM_DAILY_TOKEN_BUDGET);
    expect(dailyTokenBudgetForPlan("premium")).toBe(TRIAL_PREMIUM_DAILY_TOKEN_BUDGET);
  });

  it("gives free no token budget — the courtesy quota bounds it instead", () => {
    expect(dailyTokenBudgetForPlan("free")).toBeNull();
  });
});

describe("isWorkspaceTokenBudgetExhausted", () => {
  it("is false below the budget and true once it is reached", () => {
    expect(
      isWorkspaceTokenBudgetExhausted(TRIAL_PREMIUM_DAILY_TOKEN_BUDGET - 1, "premium"),
    ).toBe(false);
    expect(
      isWorkspaceTokenBudgetExhausted(TRIAL_PREMIUM_DAILY_TOKEN_BUDGET, "premium"),
    ).toBe(true);
    expect(
      isWorkspaceTokenBudgetExhausted(TRIAL_PREMIUM_DAILY_TOKEN_BUDGET + 1, "trial"),
    ).toBe(true);
  });

  it("never bites a free workspace, however many tokens it consumed", () => {
    expect(
      isWorkspaceTokenBudgetExhausted(TRIAL_PREMIUM_DAILY_TOKEN_BUDGET * 10, "free"),
    ).toBe(false);
  });
});

describe("isGlobalTokenFuseBlown", () => {
  it("is false below the fuse and true once it is reached, for every plan", () => {
    expect(isGlobalTokenFuseBlown(GLOBAL_DAILY_TOKEN_FUSE - 1)).toBe(false);
    expect(isGlobalTokenFuseBlown(GLOBAL_DAILY_TOKEN_FUSE)).toBe(true);
  });
});
