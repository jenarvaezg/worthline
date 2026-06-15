import { describe, expect, test } from "vitest";

import {
  addHoldingFieldValue,
  buildSymbolSearchCurrentParams,
  firstNonEmptyParam,
  selectedInstrumentFromAddHoldingState,
} from "./search-state";

describe("add holding search state", () => {
  test("recovers the selected instrument and query from the noisy add-form GET", () => {
    const searchParams = {
      $ACTION_ID_606cd9876f9b2a87de3e8305691d4976b93ffe6529: "",
      instrument: "fund",
      name_current_account: "",
      name_etf: "",
      name_fund: "Vanguard European Stock Index Fund",
      ownershipPreset: "scope",
      scopeMemberId: "mJ",
      symbolq: ["IE0007987708.IR", "", "", ""],
      value_current_account: "",
    };
    const selectedInstrument = selectedInstrumentFromAddHoldingState({}, searchParams);

    expect(selectedInstrument).toBe("fund");
    expect(firstNonEmptyParam(searchParams.symbolq)).toBe("IE0007987708.IR");
    expect(
      addHoldingFieldValue({
        field: "name",
        instrument: "fund",
        searchParams,
        selectedInstrument,
        values: {},
      }),
    ).toBe("Vanguard European Stock Index Fund");
  });

  test("keeps only selected-instrument and shared fields for result links", () => {
    const params = buildSymbolSearchCurrentParams({
      $ACTION_ID_606cd9876f9b2a87de3e8305691d4976b93ffe6529: "",
      instrument: "fund",
      name_current_account: "Cuenta",
      name_etf: "ETF",
      name_fund: "Vanguard European Stock Index Fund",
      ownershipPreset: "scope",
      price_fund: "",
      scopeMemberId: "mJ",
      symbolq: ["IE0007987708.IR", "", ""],
      value_current_account: "100",
    });

    expect(params).toEqual({
      instrument: "fund",
      name_fund: "Vanguard European Stock Index Fund",
      ownershipPreset: "scope",
      scopeMemberId: "mJ",
    });
  });
});
