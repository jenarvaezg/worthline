import { describe, expect, it } from "vitest";

import {
  type CorrectionPoint,
  computeCorrectionGate,
  editCorrectionPoint,
} from "./anchor-correction-gate";

const point = (over: Partial<CorrectionPoint>): CorrectionPoint => ({
  balanceMinor: 100_00,
  date: "2026-07-08",
  origin: "assistant",
  ...over,
});

describe("computeCorrectionGate", () => {
  it("solo-desde-hoy always confirms and declares the past intact", () => {
    const gate = computeCorrectionGate({
      anchorMinor: null,
      mode: "solo-desde-hoy",
      series: [point({ balanceMinor: 5_587_10 })],
    });
    expect(gate.canConfirm).toBe(true);
    expect(gate.guarantee).toEqual({ state: "declared" });
    expect(gate.resultingMinor).toBe(5_587_10);
  });

  it("reconstruir unlocks Confirmar only when the endpoint reconciles", () => {
    const matched = computeCorrectionGate({
      anchorMinor: 5_000_00,
      mode: "reconstruir",
      series: [point({ balanceMinor: 6_000_00 }), point({ balanceMinor: 5_000_00 })],
    });
    expect(matched.canConfirm).toBe(true);
    expect(matched.guarantee.state).toBe("reconciled");

    const mismatched = computeCorrectionGate({
      anchorMinor: 5_000_00,
      mode: "reconstruir",
      series: [point({ balanceMinor: 4_900_00 })],
    });
    expect(mismatched.canConfirm).toBe(false);
    expect(mismatched.guarantee.state).toBe("mismatch");
  });

  it("the endpoint is the last non-excluded point", () => {
    const gate = computeCorrectionGate({
      anchorMinor: 6_000_00,
      mode: "reconstruir",
      series: [
        point({ balanceMinor: 6_000_00 }),
        point({ balanceMinor: 4_000_00, excluded: true }),
      ],
    });
    expect(gate.resultingMinor).toBe(6_000_00);
    expect(gate.matches).toBe(true);
  });

  it("no anchor forces an unverified review that blocks Confirmar", () => {
    const gate = computeCorrectionGate({
      anchorMinor: null,
      mode: "reconstruir",
      series: [point({ balanceMinor: 3_000_00 })],
    });
    expect(gate.canConfirm).toBe(false);
    expect(gate.guarantee).toEqual({ state: "unverified" });
  });
});

describe("editCorrectionPoint", () => {
  it("overriding an amount marks the point corrected by you", () => {
    const series = [point({ balanceMinor: 100_00 })];
    const edited = editCorrectionPoint(series, 0, { balanceMinor: 90_00 });
    expect(edited[0]).toMatchObject({ balanceMinor: 90_00, origin: "user" });
    // Immutable: the input is untouched.
    expect(series[0]!.balanceMinor).toBe(100_00);
  });

  it("toggling exclusion leaves the origin intact", () => {
    const series = [point({ origin: "assistant" })];
    const edited = editCorrectionPoint(series, 0, { excluded: true });
    expect(edited[0]).toMatchObject({ excluded: true, origin: "assistant" });
  });

  it("an out-of-range index returns the series unchanged", () => {
    const series = [point({})];
    expect(editCorrectionPoint(series, 5, { excluded: true })).toEqual(series);
  });
});
