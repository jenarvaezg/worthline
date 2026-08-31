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
  seniorityRaw: "",
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

describe("la antigüedad heredada (#1518)", () => {
  test("empty stays empty — the landing day is never a stand-in", () => {
    const resolved = resolveExternalTransferCapture(ENERO);
    if (!resolved.ok) throw new Error("expected a capture");

    expect(resolved.seniorityAt).toBeUndefined();
    expect(resolved.executedAt).toBe("2026-01-23");
  });

  test("a declared date rides the entry beside the day it landed", () => {
    const resolved = resolveExternalTransferCapture({
      ...ENERO,
      seniorityRaw: "2014-03-01",
    });
    if (!resolved.ok) throw new Error("expected a capture");

    expect(resolved.seniorityAt).toBe("2014-03-01");
  });

  test("a date after the entry is refused in the gate's own words", () => {
    const resolved = resolveExternalTransferCapture({
      ...ENERO,
      seniorityRaw: "2026-02-01",
    });

    expect(resolved).toEqual({
      error:
        "La antigüedad que traen esas participaciones (1 feb 2026) es posterior al día en que entraron (23 ene 2026). Una movilización hereda antigüedad de antes, nunca de después.",
      ok: false,
    });
  });

  test("an empty field says what it costs to leave it empty", () => {
    const copy = externalTransferCaptureCopy(ENERO);

    expect(copy.seniorityRefused).toBe(false);
    expect(copy.seniorityNote).toBe(
      "Vacío: el libro no sabrá desde cuándo cuenta la antigüedad de ese dinero — y en un plan de pensiones es lo que decide qué parte se puede rescatar.",
    );
  });

  test("a declared date echoes what it means, in es-ES", () => {
    const copy = externalTransferCaptureCopy({ ...ENERO, seniorityRaw: "2014-03-01" });

    expect(copy.seniorityNote).toBe(
      "Antigüedad desde el 1 mar 2014, no desde el día en que entró el dinero.",
    );
  });

  test("its refusal sits beside its own field and blanks nothing above it", () => {
    const copy = externalTransferCaptureCopy({ ...ENERO, seniorityRaw: "2026-02-01" });

    expect(copy.seniorityRefused).toBe(true);
    expect(copy.seniorityNote).toContain("posterior al día en que entraron");
    expect(copy.refused).toBe(false);
    expect(copy.hint).toContain("7,6368");
    expect(copy.costRefused).toBe(false);
  });

  test("an unreadable importe leaves the seniority field explaining itself, not accusing it", () => {
    // The refusal belongs under the participaciones, where the wrong figure is. This
    // field only says what it is FOR — pointing the user here would be a dead end.
    const copy = externalTransferCaptureCopy({
      ...ENERO,
      amountRaw: "noventa",
      seniorityRaw: "2014-03-01",
    });

    expect(copy.refused).toBe(true);
    expect(copy.seniorityRefused).toBe(false);
    expect(copy.seniorityNote).toBe(
      "Desde cuándo cuenta la antigüedad de ese dinero, según la entidad anterior.",
    );
  });
});
