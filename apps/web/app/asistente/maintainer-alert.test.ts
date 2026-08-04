import type {
  AgentViewCalculationTrace,
  AgentViewHoldingDetail,
} from "@web/agent-view/contract";
import { describe, expect, it } from "vitest";

import { EXTRACTED_DATA_LIMITS } from "./bound-extracted-data";
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

  it("keeps the cron's own category out of the assistant's vocabulary (#1339)", () => {
    // `missed_capture` is raised by the daily-capture cron about itself; no model
    // may ever raise it through the chat tool.
    expect(isMaintainerAlertCategory("missed_capture")).toBe(false);
  });

  it("labels each category in Spanish", () => {
    expect(maintainerAlertCategoryLabel("infidelity")).toMatch(/infidelidad/i);
    expect(maintainerAlertCategoryLabel("residual")).toMatch(/residuo/i);
    expect(maintainerAlertCategoryLabel("sync_source")).toMatch(/sync/i);
    expect(maintainerAlertCategoryLabel("missed_capture")).toMatch(/captura/i);
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
      // The painted figure travels with the snapshot (#1347): it is the other
      // half of «the two conflicting figures» whenever there is no trace.
      currentValue: { amountMinor: 587_900, currency: "EUR" },
    });
    // No connected source on this holding, so the key stays absent.
    expect(payload.holding).not.toHaveProperty("source");
    expect(payload.calculationTrace).toBe(TRACE);
    expect(payload.declared?.balanceMinor).toBe(559_200);
    expect(payload.extractedData).toEqual({
      rows: [{ date: "2026-07-15", balanceMinor: 559_200 }],
    });
    expect(payload.conversationRef).toBe("msg-1");
    // No unavailable reason when the trace is present.
    expect(payload).not.toHaveProperty("calculationTraceUnavailable");
  });

  it("carries the connected source when one materialized the holding (#1347)", () => {
    const payload = buildMaintainerAlertPayload({
      category: "sync_source",
      summary: "Binance lleva semanas sin sincronizar",
      raisedAt: "2026-07-30T20:12:00.000Z",
      detail: {
        ...DETAIL,
        sourceSummary: { label: "Binance", adapter: "binance", lastSyncAt: null },
      } as unknown as AgentViewHoldingDetail,
      calculationTrace: null,
    });

    // What makes the smell diagnosable without a magnitude: which adapter, how stale.
    expect(payload.holding?.source).toEqual({
      adapter: "binance",
      label: "Binance",
      lastSyncAt: null,
    });
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

describe("buildMaintainerAlertPayload · extractedData is bounded at the seam (#1180)", () => {
  /** The base payload the tool passes through, with a hostile `extractedData`. */
  function payloadWith(extractedData: unknown) {
    return buildMaintainerAlertPayload({
      category: "infidelity",
      summary: "resumen",
      raisedAt: "2026-07-24T10:00:00.000Z",
      detail: DETAIL,
      calculationTrace: TRACE,
      extractedData,
    });
  }

  it("bounds it as it enters the payload, not only at render time", () => {
    // The cap must live in the shaping seam every caller goes through: the
    // control-plane row is what must stay small, not just the /admin <pre>.
    const payload = payloadWith({
      nota: "z".repeat(EXTRACTED_DATA_LIMITS.maxStringChars * 4),
    });

    expect(JSON.stringify(payload.extractedData).length).toBeLessThanOrEqual(
      EXTRACTED_DATA_LIMITS.maxSerializedChars,
    );
  });

  it("keeps an absent extraction absent, so the key stays optional", () => {
    expect("extractedData" in payloadWith(undefined)).toBe(false);
  });
});
