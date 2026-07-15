import type {
  AgentViewCalculationTrace,
  AgentViewHoldingDetail,
} from "@web/agent-view/contract";
import { describe, expect, it } from "vitest";

import {
  buildMaintainerAlertPayload,
  isMaintainerAlertCategory,
  maintainerAlertCategoryLabel,
} from "./maintainer-alert";

const DETAIL = {
  id: "wl_hld_loan",
  object: "holding",
  direction: "liability",
  label: "Préstamo coche",
  instrument: "loan",
  valuationMethod: "amortized",
  liquidityTier: "illiquid",
  currentValue: { amountMinor: 587_900, currency: "EUR" },
  ownership: [],
  qualitySummary: { hasWarnings: false },
  vsBenchmark: { comparison: null, unavailableReason: "no_tracked_index" },
} as unknown as AgentViewHoldingDetail;

const TRACE = {
  object: "calculation_trace",
  holding: "wl_hld_loan",
  direction: "liability",
  model: "amortizable",
  asOf: "2026-07-15",
  currentValue: { amountMinor: 587_900, currency: "EUR" },
  reconciliation: [],
  fidelity: { faithful: false, divergences: [], checkedPoints: 3 },
  tolerance: {
    band: { amountMinor: 294, currency: "EUR" },
    referenceBalance: { amountMinor: 587_900, currency: "EUR" },
    referenceDate: "2026-07-15",
  },
  omittedReconciliationPoints: 0,
} as unknown as AgentViewCalculationTrace;

describe("maintainer-alert category helpers", () => {
  it("recognizes the three categories and rejects others", () => {
    expect(isMaintainerAlertCategory("infidelity")).toBe(true);
    expect(isMaintainerAlertCategory("residual")).toBe(true);
    expect(isMaintainerAlertCategory("sync_source")).toBe(true);
    expect(isMaintainerAlertCategory("nonsense")).toBe(false);
  });

  it("labels each category in Spanish", () => {
    expect(maintainerAlertCategoryLabel("infidelity")).toMatch(/infidelidad/i);
    expect(maintainerAlertCategoryLabel("residual")).toMatch(/residuo/i);
    expect(maintainerAlertCategoryLabel("sync_source")).toMatch(/sync/i);
  });
});

describe("buildMaintainerAlertPayload", () => {
  it("assembles the config snapshot, trace, and declared figure", () => {
    const payload = buildMaintainerAlertPayload({
      category: "infidelity",
      summary: "pintado != recomputado",
      raisedAt: "2026-07-15T10:00:00.000Z",
      detail: DETAIL,
      calculationTrace: TRACE,
      declared: {
        balanceMinor: 559_200,
        currency: "EUR",
        date: "2026-07-15",
        source: "extracto del banco",
      },
      extractedData: { rows: [{ date: "2026-07-15", balanceMinor: 559_200 }] },
      conversationRef: "msg-1",
    });

    expect(payload.holding).toEqual({
      id: "wl_hld_loan",
      label: "Préstamo coche",
      direction: "liability",
      instrument: "loan",
      valuationMethod: "amortized",
    });
    expect(payload.calculationTrace).toBe(TRACE);
    expect(payload.declared?.balanceMinor).toBe(559_200);
    expect(payload.extractedData).toEqual({
      rows: [{ date: "2026-07-15", balanceMinor: 559_200 }],
    });
    expect(payload.conversationRef).toBe("msg-1");
    // No unavailable reason when the trace is present.
    expect(payload).not.toHaveProperty("calculationTraceUnavailable");
  });

  it("records why the trace is missing without a holding snapshot", () => {
    const payload = buildMaintainerAlertPayload({
      category: "sync_source",
      summary: "olor a sync",
      raisedAt: "2026-07-15T10:00:00.000Z",
      detail: null,
      calculationTrace: null,
      calculationTraceUnavailable:
        "The calculation trace is available only for debt holdings with a debt model.",
    });

    expect(payload.holding).toBeNull();
    expect(payload.calculationTrace).toBeNull();
    expect(payload.calculationTraceUnavailable).toMatch(/debt/);
    expect(payload).not.toHaveProperty("declared");
    expect(payload).not.toHaveProperty("extractedData");
  });
});
