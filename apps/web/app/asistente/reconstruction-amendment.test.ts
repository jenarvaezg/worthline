/**
 * The amendment layer over a reconstruction's observed series (#1423), as a pure
 * module: «quita los puntos estimados a partir de agosto de 2026» is two fields,
 * never a re-emission of the 49 rows.
 */

import { describe, expect, test } from "vitest";

import {
  amendedReconstructionSeries,
  effectiveReconstructionRows,
  normalizeReconstructionAmendments,
  RECONSTRUCTION_AMENDMENT_MESSAGES,
} from "./reconstruction-amendment";

const OBSERVED = [
  { balanceMinor: 150_000_00, date: "2026-05-01" },
  { balanceMinor: 148_000_00, date: "2026-06-01" },
  { balanceMinor: 146_000_00, date: "2026-07-01" },
  { balanceMinor: 144_000_00, date: "2026-08-01" },
  { balanceMinor: 142_000_00, date: "2026-09-01" },
  { balanceMinor: 140_000_00, date: "2026-10-01" },
];

describe("amendedReconstructionSeries · exclusión (#1423)", () => {
  test("excluye por rango abierto: «a partir de septiembre de 2026»", () => {
    const amended = amendedReconstructionSeries(
      OBSERVED,
      [],
      [{ action: "exclude", from: "2026-09-01" }],
    );
    expect(amended.ok).toBe(true);
    if (!amended.ok) return;
    expect(amended.amendments).toEqual([
      { date: "2026-09-01", excluded: true },
      { date: "2026-10-01", excluded: true },
    ]);
    expect(amended.excludedDates).toEqual(["2026-09-01", "2026-10-01"]);
    expect(effectiveReconstructionRows(OBSERVED, amended.amendments)).toEqual(
      OBSERVED.slice(0, 4),
    );
  });

  test("excluye un punto suelto por fecha", () => {
    const amended = amendedReconstructionSeries(
      OBSERVED,
      [],
      [{ action: "exclude", date: "2026-07-01" }],
    );
    if (!amended.ok) throw new Error(amended.error);
    expect(amended.amendments).toEqual([{ date: "2026-07-01", excluded: true }]);
  });

  test("excluye un rango cerrado y deja fuera lo demás", () => {
    const amended = amendedReconstructionSeries(
      OBSERVED,
      [],
      [{ action: "exclude", from: "2026-06-01", to: "2026-07-31" }],
    );
    if (!amended.ok) throw new Error(amended.error);
    expect(amended.excludedDates).toEqual(["2026-06-01", "2026-07-01"]);
  });

  test("reincluye lo que una enmienda anterior había quitado", () => {
    const first = amendedReconstructionSeries(
      OBSERVED,
      [],
      [{ action: "exclude", from: "2026-09-01" }],
    );
    if (!first.ok) throw new Error(first.error);
    const second = amendedReconstructionSeries(OBSERVED, first.amendments, [
      { action: "include", date: "2026-10-01" },
    ]);
    if (!second.ok) throw new Error(second.error);
    expect(second.amendments).toEqual([{ date: "2026-09-01", excluded: true }]);
    expect(second.excludedDates).toEqual(["2026-09-01"]);
  });

  test("rechaza un rango que no toca ningún punto en vez de callar", () => {
    const amended = amendedReconstructionSeries(
      OBSERVED,
      [],
      [{ action: "exclude", from: "2027-01-01" }],
    );
    expect(amended).toEqual({
      error: RECONSTRUCTION_AMENDMENT_MESSAGES.emptySelection,
      ok: false,
    });
  });

  test("rechaza vaciar la serie entera: no quedaría nada que aplicar", () => {
    const amended = amendedReconstructionSeries(
      OBSERVED,
      [],
      [{ action: "exclude", from: "2026-01-01" }],
    );
    expect(amended).toEqual({
      error: RECONSTRUCTION_AMENDMENT_MESSAGES.nothingLeft,
      ok: false,
    });
  });
});

describe("amendedReconstructionSeries · importe corregido (#1423)", () => {
  test("corrige el importe de un punto y lo marca como tuyo", () => {
    const amended = amendedReconstructionSeries(
      OBSERVED,
      [],
      [{ action: "set_balance", balanceMinor: 145_500_00, date: "2026-07-01" }],
    );
    if (!amended.ok) throw new Error(amended.error);
    expect(amended.amendments).toEqual([
      { balanceMinor: 145_500_00, date: "2026-07-01" },
    ]);
    expect(amended.correctedDates).toEqual(["2026-07-01"]);
    expect(effectiveReconstructionRows(OBSERVED, amended.amendments)[2]).toEqual({
      balanceMinor: 145_500_00,
      date: "2026-07-01",
    });
  });

  test("una corrección sobre un punto excluido lo reincluye: corregirlo es quererlo", () => {
    const first = amendedReconstructionSeries(
      OBSERVED,
      [],
      [{ action: "exclude", date: "2026-10-01" }],
    );
    if (!first.ok) throw new Error(first.error);
    const second = amendedReconstructionSeries(OBSERVED, first.amendments, [
      { action: "set_balance", balanceMinor: 139_000_00, date: "2026-10-01" },
    ]);
    if (!second.ok) throw new Error(second.error);
    expect(second.amendments).toEqual([{ balanceMinor: 139_000_00, date: "2026-10-01" }]);
    expect(second.excludedDates).toEqual([]);
  });

  test("rechaza una fecha que no está en la serie observada", () => {
    const amended = amendedReconstructionSeries(
      OBSERVED,
      [],
      [{ action: "set_balance", balanceMinor: 1_000_00, date: "2025-01-01" }],
    );
    expect(amended).toEqual({
      error: RECONSTRUCTION_AMENDMENT_MESSAGES.unknownDate,
      ok: false,
    });
  });

  test("rechaza un importe que no es un entero positivo de céntimos", () => {
    for (const balanceMinor of [0, -1, 12.5]) {
      const amended = amendedReconstructionSeries(
        OBSERVED,
        [],
        [{ action: "set_balance", balanceMinor, date: "2026-07-01" }],
      );
      expect(amended, String(balanceMinor)).toEqual({
        error: RECONSTRUCTION_AMENDMENT_MESSAGES.invalidBalance,
        ok: false,
      });
    }
  });

  test("exige una fecha concreta: un rango de importes sería inventar cifras", () => {
    const amended = amendedReconstructionSeries(
      OBSERVED,
      [],
      [{ action: "set_balance", balanceMinor: 1_000_00, from: "2026-07-01" }],
    );
    expect(amended).toEqual({
      error: RECONSTRUCTION_AMENDMENT_MESSAGES.balanceNeedsDate,
      ok: false,
    });
  });
});

describe("amendedReconstructionSeries · validación de la llamada (#1423)", () => {
  test("rechaza una llamada sin operaciones", () => {
    expect(amendedReconstructionSeries(OBSERVED, [], [])).toEqual({
      error: RECONSTRUCTION_AMENDMENT_MESSAGES.noOperations,
      ok: false,
    });
  });

  test("rechaza lo que ni siquiera es una lista de operaciones, sin reventar", () => {
    // `required` de un jsonSchema no se valida en runtime: esto es salida de modelo.
    for (const operations of [{}, "quita agosto", null, undefined]) {
      expect(
        amendedReconstructionSeries(OBSERVED, [], operations as never),
        String(operations),
      ).toEqual({ error: RECONSTRUCTION_AMENDMENT_MESSAGES.noOperations, ok: false });
    }
  });

  test("rechaza una acción que no existe", () => {
    expect(
      amendedReconstructionSeries(
        OBSERVED,
        [],
        [{ action: "borra_todo", date: "2026-07-01" } as never],
      ),
    ).toEqual({ error: RECONSTRUCTION_AMENDMENT_MESSAGES.unknownAction, ok: false });
  });

  test("rechaza una exclusión sin fecha ni rango", () => {
    expect(amendedReconstructionSeries(OBSERVED, [], [{ action: "exclude" }])).toEqual({
      error: RECONSTRUCTION_AMENDMENT_MESSAGES.emptyTarget,
      ok: false,
    });
  });

  test("rechaza una fecha mal formada", () => {
    expect(
      amendedReconstructionSeries(
        OBSERVED,
        [],
        [{ action: "exclude", date: "agosto de 2026" }],
      ),
    ).toEqual({ error: RECONSTRUCTION_AMENDMENT_MESSAGES.invalidDate, ok: false });
  });

  test("rechaza una tanda de operaciones desmedida: eso es reemitir la serie", () => {
    const operations = Array.from({ length: 40 }, () => ({
      action: "exclude" as const,
      date: "2026-07-01",
    }));
    expect(amendedReconstructionSeries(OBSERVED, [], operations)).toEqual({
      error: RECONSTRUCTION_AMENDMENT_MESSAGES.tooManyOperations,
      ok: false,
    });
  });
});

describe("normalizeReconstructionAmendments (#1423)", () => {
  test("lee de vuelta lo persistido y descarta la basura", () => {
    expect(
      normalizeReconstructionAmendments([
        { date: "2026-09-01", excluded: true },
        { balanceMinor: 1_000_00, date: "2026-07-01" },
        { date: "2026-08-01" },
        { date: 7 },
        null,
        "nope",
      ]),
    ).toEqual([
      { date: "2026-07-01", balanceMinor: 1_000_00 },
      { date: "2026-09-01", excluded: true },
    ]);
  });

  test("sin enmiendas, la serie efectiva es la observada", () => {
    expect(normalizeReconstructionAmendments(undefined)).toEqual([]);
    expect(effectiveReconstructionRows(OBSERVED, [])).toEqual(OBSERVED);
  });

  test("una enmienda por fecha alcanza a todas sus observaciones repetidas", () => {
    const repeated = [
      { balanceMinor: 169_653_18, date: "2026-06-01" },
      { balanceMinor: 164_153_18, date: "2026-06-01" },
      { balanceMinor: 140_000_00, date: "2026-07-01" },
    ];
    expect(
      effectiveReconstructionRows(repeated, [{ date: "2026-06-01", excluded: true }]),
    ).toEqual([{ balanceMinor: 140_000_00, date: "2026-07-01" }]);
  });
});
