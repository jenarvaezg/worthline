import type {
  AgentViewCalculationTrace,
  AgentViewHoldingDetail,
} from "@web/agent-view/contract";
import { describe, expect, it } from "vitest";

import {
  boundExtractedData,
  buildMaintainerAlertPayload,
  EXTRACTED_DATA_LIMITS,
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

describe("boundExtractedData (#1180)", () => {
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

  it("passes an ordinary extraction through untouched", () => {
    const extracted = {
      saldo: 587_900,
      fecha: "2026-07-15",
      filas: [{ concepto: "cuota", importe: -32_150 }],
    };
    expect(boundExtractedData(extracted)).toEqual(extracted);
  });

  it("truncates a string past the character cap and marks it", () => {
    const bounded = boundExtractedData({
      nota: "x".repeat(EXTRACTED_DATA_LIMITS.maxStringChars + 500),
    }) as { nota: string };

    expect(bounded.nota.length).toBeLessThan(EXTRACTED_DATA_LIMITS.maxStringChars + 40);
    expect(bounded.nota).toContain("…");
    expect(bounded.nota.startsWith("x".repeat(100))).toBe(true);
  });

  it("caps array length and says how many items it dropped", () => {
    const rows = Array.from(
      { length: EXTRACTED_DATA_LIMITS.maxArrayItems + 37 },
      (_, i) => ({
        i,
      }),
    );
    const bounded = boundExtractedData(rows) as unknown[];

    expect(bounded).toHaveLength(EXTRACTED_DATA_LIMITS.maxArrayItems + 1);
    expect(bounded[EXTRACTED_DATA_LIMITS.maxArrayItems]).toContain("37");
  });

  it("caps the number of object keys", () => {
    const wide = Object.fromEntries(
      Array.from({ length: EXTRACTED_DATA_LIMITS.maxObjectKeys + 20 }, (_, i) => [
        `k${i}`,
        i,
      ]),
    );
    const bounded = boundExtractedData(wide) as Record<string, unknown>;

    expect(Object.keys(bounded)).toHaveLength(EXTRACTED_DATA_LIMITS.maxObjectKeys + 1);
    expect(bounded["k0"]).toBe(0);
    expect(String(bounded[EXTRACTED_DATA_LIMITS.omittedKey])).toContain("20");
  });

  it("stops at the depth cap instead of recursing forever", () => {
    // A 200-deep chain: JSON.stringify would blow the stack long before /admin
    // ever rendered it.
    let deep: Record<string, unknown> = { fondo: "tocado" };
    for (let i = 0; i < 200; i += 1) deep = { nivel: deep };

    const bounded = boundExtractedData(deep);
    const serialized = JSON.stringify(bounded);

    expect(serialized).toContain("…");
    expect(serialized).not.toContain("tocado");
    expect(serialized.length).toBeLessThan(400);
  });

  it("survives a self-referencing object (the depth cap breaks the cycle)", () => {
    const cyclic: Record<string, unknown> = { saldo: 100 };
    cyclic["self"] = cyclic;

    const bounded = boundExtractedData(cyclic);
    expect(() => JSON.stringify(bounded)).not.toThrow();
  });

  it("replaces the whole blob when it still exceeds the serialized budget", () => {
    // Many rows, each individually legal: the per-node caps let it through but
    // the total is still far past what a control-plane row should carry.
    const bloated = Object.fromEntries(
      Array.from({ length: EXTRACTED_DATA_LIMITS.maxObjectKeys }, (_, i) => [
        `k${i}`,
        "y".repeat(EXTRACTED_DATA_LIMITS.maxStringChars),
      ]),
    );

    const bounded = boundExtractedData(bloated) as Record<string, unknown>;

    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(
      EXTRACTED_DATA_LIMITS.maxSerializedChars,
    );
    expect(String(bounded[EXTRACTED_DATA_LIMITS.omittedKey])).toMatch(/omitid/i);
  });

  it("drops values JSON cannot carry rather than emitting undefined", () => {
    const bounded = boundExtractedData({
      ok: 1,
      fn: () => 1,
      undef: undefined,
      big: 10n,
      nan: Number.NaN,
    }) as Record<string, unknown>;

    expect(bounded["ok"]).toBe(1);
    expect("fn" in bounded).toBe(false);
    expect("undef" in bounded).toBe(false);
    expect(bounded["big"]).toBe("10");
    expect(bounded["nan"]).toBeNull();
  });

  it("keeps undefined as absent, so the payload key stays optional", () => {
    expect(boundExtractedData(undefined)).toBeUndefined();
    expect("extractedData" in payloadWith(undefined)).toBe(false);
  });

  it("bounds extractedData as it enters the payload, not only at render time", () => {
    // The cap must live in the shaping seam every caller goes through: the
    // control-plane row is what must stay small, not just the /admin <pre>.
    const payload = payloadWith({
      nota: "z".repeat(EXTRACTED_DATA_LIMITS.maxStringChars * 4),
    });

    expect(JSON.stringify(payload.extractedData).length).toBeLessThanOrEqual(
      EXTRACTED_DATA_LIMITS.maxSerializedChars,
    );
  });

  it("leaves an explicit null alone (a fact, not a bloat vector)", () => {
    expect(boundExtractedData(null)).toBeNull();
  });
});
