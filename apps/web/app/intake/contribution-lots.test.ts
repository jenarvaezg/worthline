import { describe, expect, test } from "vitest";
import {
  PENSION_LIQUIDITY_WINDOW_YEARS,
  parseContributionLot,
  suggestedLotAvailableFrom,
} from "./contribution-lots";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("suggestedLotAvailableFrom (#1676)", () => {
  test("propone la antigüedad heredada más la ventana normativa", () => {
    // La antigüedad de la cartera real: un traspaso externo con aportaciones de 2014.
    expect(suggestedLotAvailableFrom("2014-03-01")).toBe("2024-03-01");
    expect(PENSION_LIQUIDITY_WINDOW_YEARS).toBe(10);
  });

  // Sin antigüedad no hay nada que proponer, y proponer la fecha de la fila sería la
  // invención que #1518 y #1528 vinieron a cerrar.
  test("no propone nada sin antigüedad declarada", () => {
    expect(suggestedLotAvailableFrom(null)).toBeNull();
  });

  test("no propone nada sobre una fecha que el calendario no tiene", () => {
    expect(suggestedLotAvailableFrom("2014-02-30")).toBeNull();
  });

  // Hacia adelante, nunca hacia atrás: un día antes prometería liquidez que no existe.
  test("un 29 de febrero cae en el 1 de marzo del año que no lo tiene", () => {
    expect(suggestedLotAvailableFrom("2016-02-29")).toBe("2026-03-01");
  });

  test("un 29 de febrero que sí existe diez años después se queda donde cae", () => {
    expect(suggestedLotAvailableFrom("2004-02-29")).toBe("2014-03-01");
  });
});

describe("parseContributionLot (#1676)", () => {
  test("acepta fecha e importe, y devuelve el importe en unidades menores", () => {
    const parsed = parseContributionLot(
      form({ lotAmount: "4.979,55", lotAvailableFrom: "2024-03-01" }),
    );

    expect(parsed).toEqual({
      amountMinor: 497_955,
      availableFrom: "2024-03-01",
      ok: true,
    });
  });

  test("rechaza un día que el calendario no tiene, en vez de desplazarlo en silencio", () => {
    const parsed = parseContributionLot(
      form({ lotAmount: "4000", lotAvailableFrom: "2035-02-30" }),
    );

    expect(parsed.ok).toBe(false);
  });

  test("rechaza el lote sin fecha y el lote sin importe, cada uno con su frase", () => {
    const sinFecha = parseContributionLot(
      form({ lotAmount: "4000", lotAvailableFrom: "" }),
    );
    const sinImporte = parseContributionLot(
      form({ lotAmount: "", lotAvailableFrom: "2031-05-01" }),
    );

    expect(sinFecha.ok).toBe(false);
    expect(sinImporte.ok).toBe(false);
    if (sinFecha.ok || sinImporte.ok) throw new Error("expected both to fail");
    expect(sinFecha.error).not.toBe(sinImporte.error);
  });

  test("un lote de cero o negativo no es una declaración", () => {
    expect(
      parseContributionLot(form({ lotAmount: "0", lotAvailableFrom: "2031-05-01" })).ok,
    ).toBe(false);
    expect(
      parseContributionLot(form({ lotAmount: "-5", lotAvailableFrom: "2031-05-01" })).ok,
    ).toBe(false);
  });
});
