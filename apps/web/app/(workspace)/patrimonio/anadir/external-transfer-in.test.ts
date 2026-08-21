import { describe, expect, test } from "vitest";

import {
  externalTransferCaptureCopy,
  resolveExternalTransferCapture,
} from "./external-transfer-in";

/**
 * The «viene traspasada de otra entidad» capture (#1541, S6 of PRD #1393).
 *
 * The worked example throughout is Jorge's real one: on 23-ene-2026 MyInvestor's
 * «Traer plan desde otra entidad» landed 95,46 € into his pension plan. That row is
 * in production and the 19-ago retyping pass had to hand-write it, because the alta
 * had no way to say «this arrived by traspaso» — the whole reason for this slice.
 */

const TODAY = "2026-06-15";

/** The enero-2026 entry, as the pane posts it. */
const ENERO = {
  amountRaw: "95,46",
  costRaw: "",
  dateRaw: "2026-01-23",
  priceRaw: "12,50",
  today: TODAY,
};

describe("resolveExternalTransferCapture", () => {
  test("derives the participaciones from the importe and the VL of that date", () => {
    const resolved = resolveExternalTransferCapture(ENERO);

    expect(resolved).toEqual({
      amountMinor: 9_546,
      executedAt: "2026-01-23",
      inheritedCostMinor: 9_546,
      ok: true,
      pricePerUnit: "12.50",
      units: "7.6368",
    });
  });

  test("an undeclared cost defaults to the importe that arrived — no invented plusvalía", () => {
    const resolved = resolveExternalTransferCapture(ENERO);

    expect(resolved.ok && resolved.inheritedCostMinor).toBe(9_546);
  });

  test("a declared cost is what the units carry, and it may be below what arrived", () => {
    const resolved = resolveExternalTransferCapture({ ...ENERO, costRaw: "80,00" });

    expect(resolved.ok && resolved.inheritedCostMinor).toBe(8_000);
  });

  test("a blank date means today, so the entry is never undated", () => {
    const resolved = resolveExternalTransferCapture({ ...ENERO, dateRaw: "" });

    expect(resolved.ok && resolved.executedAt).toBe(TODAY);
  });

  test("a future date is refused: capital that has not landed yet is not history", () => {
    const resolved = resolveExternalTransferCapture({ ...ENERO, dateRaw: "2026-07-01" });

    expect(resolved).toEqual({
      error: "No puedes tener la posición desde una fecha futura.",
      ok: false,
    });
  });

  test("an importe that does not read is refused before anything is written", () => {
    const resolved = resolveExternalTransferCapture({
      ...ENERO,
      amountRaw: "noventa y cinco",
    });

    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error).toMatch(/importe/i);
  });

  test("a zero importe is refused with the gate's own words", () => {
    const resolved = resolveExternalTransferCapture({ ...ENERO, amountRaw: "0" });

    expect(resolved).toEqual({
      error: "Indica cuánto se ha traspasado, en euros.",
      ok: false,
    });
  });

  test("a VL of zero is refused with the gate's own words", () => {
    const resolved = resolveExternalTransferCapture({ ...ENERO, priceRaw: "0" });

    expect(resolved).toEqual({
      error:
        "Necesito el valor liquidativo de la inversión de destino en la fecha del traspaso.",
      ok: false,
    });
  });

  test("a cost that does not read is refused rather than dropped to the default", () => {
    const resolved = resolveExternalTransferCapture({ ...ENERO, costRaw: "ochenta" });

    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error).toMatch(/coste/i);
  });
});

describe("externalTransferCaptureCopy", () => {
  test("reads back the participaciones and the day the history is rebuilt from", () => {
    const copy = externalTransferCaptureCopy(ENERO);

    expect(copy.refused).toBe(false);
    expect(copy.hint).toBe(
      "≈ 7,6368 participaciones al 23 ene 2026 — reconstruiremos el histórico desde ese día.",
    );
  });

  test("with no importe yet it says what to type instead of shouting an error", () => {
    const copy = externalTransferCaptureCopy({ ...ENERO, amountRaw: "" });

    expect(copy.refused).toBe(false);
    expect(copy.hint).toBe("Escribe el importe que entró para ver las participaciones.");
  });

  test("a refused capture takes the hint over, so it is fixed before the submit", () => {
    const copy = externalTransferCaptureCopy({ ...ENERO, priceRaw: "0" });

    expect(copy.refused).toBe(true);
    expect(copy.hint).toBe(
      "Necesito el valor liquidativo de la inversión de destino en la fecha del traspaso.",
    );
  });

  test("an empty cost says what leaving it empty MEANS, naming the figure", () => {
    const copy = externalTransferCaptureCopy(ENERO);

    expect(copy.costRefused).toBe(false);
    expect(copy.costNote).toBe(
      "Vacío: esas participaciones entran costando los 95,46 € que llegaron, sin plusvalía latente inventada.",
    );
  });

  test("a declared cost echoes the latent gain it reveals", () => {
    const copy = externalTransferCaptureCopy({ ...ENERO, costRaw: "80,00" });

    expect(copy.costNote).toBe("80,00 € de coste heredado · plusvalía latente +15,46 €.");
  });

  test("a cost above what arrived reads as the minusvalía it is", () => {
    const copy = externalTransferCaptureCopy({ ...ENERO, costRaw: "120,00" });

    expect(copy.costNote).toBe(
      "120,00 € de coste heredado · minusvalía latente -24,54 €.",
    );
  });

  test("a cost that does not read is refused beside its own field", () => {
    const copy = externalTransferCaptureCopy({ ...ENERO, costRaw: "ochenta" });

    expect(copy.costRefused).toBe(true);
    expect(copy.costNote).toMatch(/coste/i);
    // …and it does not blank the participaciones reading above it.
    expect(copy.refused).toBe(false);
    expect(copy.hint).toContain("7,6368");
  });
});
