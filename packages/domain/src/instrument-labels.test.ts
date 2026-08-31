import { describe, expect, test } from "vitest";
import { INSTRUMENTS } from "./instrument-catalog";
import { INSTRUMENT_LABELS_ES, instrumentLabelEs } from "./instrument-labels";

describe("instrumentLabelEs (#154/#1512)", () => {
  test("labels every instrument in the catalog", () => {
    for (const instrument of INSTRUMENTS) {
      expect(instrumentLabelEs(instrument)).toBeTruthy();
    }
    expect(Object.keys(INSTRUMENT_LABELS_ES)).toHaveLength(INSTRUMENTS.length);
  });

  test("keeps the wording the board's grouping headers already showed", () => {
    expect(instrumentLabelEs("property")).toBe("Inmueble");
    expect(instrumentLabelEs("pension_plan")).toBe("Plan de pensiones");
    expect(instrumentLabelEs("other")).toBe("Otro");
  });
});
