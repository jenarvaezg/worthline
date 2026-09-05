import { describe, expect, test } from "vitest";

import {
  classifySecurityId,
  normalizeDgsCode,
  normalizedSecurityIdColumnValue,
  securityIdFieldForInstrument,
} from "./security-id";

describe("classifySecurityId", () => {
  test("recognises canonical securities from loose input without guessing an identity", () => {
    expect(classifySecurityId(" ie00b4l5y983 ")).toEqual({
      kind: "isin",
      value: "IE00B4L5Y983",
    });
    expect(classifySecurityId(" n- 5394 ")).toEqual({ kind: "dgs", value: "N5394" });
    for (const input of [
      "F5394",
      "IE00B4L5Y984",
      "",
      "N539",
      "N53940",
      null,
      undefined,
      5394,
      {},
      [],
      Symbol("N5394"),
    ]) {
      expect(classifySecurityId(input)).toBeNull();
    }
  });
});

describe("security identifier writes", () => {
  test("normalizes a plan code while rejecting a pension fund code with actionable guidance", () => {
    for (const input of ["n5394", "N-5394", "N 5394", " \tn-53 94\n"]) {
      expect(normalizeDgsCode(input)).toBe("N5394");
      expect(normalizedSecurityIdColumnValue("dgs", input)).toBe("N5394");
    }
    expect(normalizeDgsCode("F2244")).toBeNull();
    expect(() => normalizedSecurityIdColumnValue("dgs", "f-2244")).toThrow(
      "F2244 es el código del fondo de pensiones, no del plan; el del plan empieza por N y también está impreso en tu papel.",
    );
    expect(normalizedSecurityIdColumnValue("isin", " ie00b4l5y983 ")).toBe(
      "IE00B4L5Y983",
    );
    expect(() => normalizedSecurityIdColumnValue("isin", "N5394")).toThrow("ISIN");
    expect(() => normalizedSecurityIdColumnValue("isin", "IE00B4L5Y984")).toThrow("ISIN");
    expect(() => normalizedSecurityIdColumnValue("dgs", "IE00B4L5Y983")).toThrow("DGS");
    for (const kind of ["isin", "dgs"] as const) {
      for (const input of [null, undefined, "", "  "]) {
        expect(normalizedSecurityIdColumnValue(kind, input)).toBeNull();
      }
    }
  });

  test("the instrument determines which identifier a form asks for", () => {
    expect(securityIdFieldForInstrument("pension_plan")).toEqual({
      kind: "dgs",
      label: "Código DGS",
    });
    for (const instrument of ["fund", "etf", "stock", "index"] as const) {
      expect(securityIdFieldForInstrument(instrument)).toEqual({
        kind: "isin",
        label: "ISIN",
      });
    }
    expect(securityIdFieldForInstrument("crypto")).toBeNull();
    expect(securityIdFieldForInstrument("property")).toBeNull();
  });
});
