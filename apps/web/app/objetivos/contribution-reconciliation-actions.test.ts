import { describe, expect, it, vi } from "vitest";

vi.mock("@web/demo/write-guard", () => ({ guardDemoWrite: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import { parseContributionPlanForm } from "./contribution-plan-form";
import {
  applyStoredValueContributionAction,
  closeContributionOccurrenceAction,
  createAndLinkContributionOperationAction,
  linkExistingContributionOperationAction,
  skipContributionOccurrenceAction,
} from "./contribution-reconciliation-actions";

describe("parseContributionPlanForm", () => {
  it("maps the compact editor to the domain plan input", () => {
    const form = new FormData();
    form.set("destinationHoldingId", "asset-1");
    form.set("mode", "money");
    form.set("amount", "1250.50");
    form.set("cadence", "monthly");
    form.set("dayOfMonth", "31");
    form.set("weekday", "1");
    form.set("startDate", "2026-07-01");
    form.set("endDate", "2027-06-30");

    expect(parseContributionPlanForm(form)).toEqual({
      destinationHoldingId: "asset-1",
      amount: { mode: "money", value: 125_050 },
      cadence: { kind: "monthly", dayOfMonth: 31 },
      startDate: "2026-07-01",
      endDate: "2027-06-30",
    });
  });
});

describe("contribution reconciliation actions", () => {
  function fakeStore() {
    const contribution = {
      id: "plan-1",
      destinationHoldingId: "asset-1",
      amount: { mode: "money" as const, value: 100_000 },
      cadence: { kind: "monthly" as const, dayOfMonth: 1 },
      startDate: "2026-07-01",
    };
    return {
      assets: {},
      close: vi.fn(),
      workspace: {
        readWorkspace: vi.fn(async () => ({ baseCurrency: "EUR" })),
      },
      contributionPlan: {
        readContributionPlan: vi.fn(async () => ({
          scopeId: "default",
          contributions: [contribution],
        })),
        linkOperation: vi.fn(),
        setOccurrenceState: vi.fn(),
      },
      createAndLinkContributionOperation: vi.fn(),
      applyStoredContributionValue: vi.fn(),
    };
  }

  it("creates truth through the atomic operation+ripple+link seam only", async () => {
    const store = fakeStore();
    const form = new FormData();
    for (const [key, value] of Object.entries({
      scopeId: "default",
      contributionId: "plan-1",
      occurrenceId: "plan-1:2026-07-01",
      executedAt: "2026-07-03",
      units: "2",
      pricePerUnit: "500",
      fees: "1.50",
    }))
      form.set(key, value);

    await expect(
      createAndLinkContributionOperationAction(form, store as never),
    ).rejects.toThrow(/^REDIRECT:/);
    expect(store.createAndLinkContributionOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        contributionId: "plan-1",
        occurrenceId: "plan-1:2026-07-01",
        operation: expect.objectContaining({
          assetId: "asset-1",
          executedAt: "2026-07-03",
          feesMinor: 150,
          units: "2",
          pricePerUnit: "500",
        }),
      }),
    );
    expect(store.contributionPlan.linkOperation).not.toHaveBeenCalled();
  });

  it("links only the operation explicitly submitted and closes/skips explicitly", async () => {
    const store = fakeStore();
    const base = new FormData();
    base.set("contributionId", "plan-1");
    base.set("occurrenceId", "plan-1:2026-07-01");
    base.set("operationId", "chosen-op");
    await expect(
      linkExistingContributionOperationAction(base, store as never),
    ).rejects.toThrow(/^REDIRECT:/);
    expect(store.contributionPlan.linkOperation).toHaveBeenCalledWith({
      contributionId: "plan-1",
      occurrenceId: "plan-1:2026-07-01",
      operationId: "chosen-op",
    });

    await expect(closeContributionOccurrenceAction(base, store as never)).rejects.toThrow(
      /^REDIRECT:/,
    );
    await expect(skipContributionOccurrenceAction(base, store as never)).rejects.toThrow(
      /^REDIRECT:/,
    );
    expect(store.contributionPlan.setOccurrenceState).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ state: "fulfilled" }),
    );
    expect(store.contributionPlan.setOccurrenceState).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ state: "skipped" }),
    );
  });

  it("applies stored truth through the atomic value-update+receipt seam", async () => {
    const store = fakeStore();
    const form = new FormData();
    for (const [key, value] of Object.entries({
      contributionId: "plan-1",
      occurrenceId: "plan-1:2026-07-01",
      assetId: "asset-1",
      newValue: "2500",
      executedAmount: "1000",
    }))
      form.set(key, value);
    await expect(
      applyStoredValueContributionAction(form, store as never),
    ).rejects.toThrow(/^REDIRECT:/);
    expect(store.applyStoredContributionValue).toHaveBeenCalledWith({
      contributionId: "plan-1",
      occurrenceId: "plan-1:2026-07-01",
      assetId: "asset-1",
      newValueMinor: 250_000,
      executedMinor: 100_000,
    });
  });
});
