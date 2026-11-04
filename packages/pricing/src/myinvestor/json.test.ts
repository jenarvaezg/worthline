import { describe, expect, it } from "vitest";

import { JsonNumber, parseMyInvestorJson } from "./json";

describe("parseMyInvestorJson", () => {
  it("keeps every number as the literal MyInvestor wrote, so no amount crosses a double", () => {
    const parsed = parseMyInvestorJson(
      '{"cash": 0.1234567890123456789, "shares": 12.3400, "rows": [7, -0.5]}',
    ) as { cash: JsonNumber; shares: JsonNumber; rows: JsonNumber[] };

    expect(parsed.cash).toBeInstanceOf(JsonNumber);
    expect(parsed.cash.source).toBe("0.1234567890123456789");
    expect(parsed.shares.source).toBe("12.3400");
    expect(parsed.rows.map((row) => row.source)).toEqual(["7", "-0.5"]);
  });

  it("leaves strings, booleans and null as they are", () => {
    expect(parseMyInvestorJson('{"a": "12.5", "b": true, "c": null}')).toEqual({
      a: "12.5",
      b: true,
      c: null,
    });
  });

  it("answers undefined for an empty body and throws on text that is not JSON", () => {
    expect(parseMyInvestorJson("  ")).toBeUndefined();
    expect(() => parseMyInvestorJson("<html>")).toThrow();
  });
});
