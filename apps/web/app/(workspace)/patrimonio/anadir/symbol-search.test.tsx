import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@worthline/pricing", () => ({
  searchSymbols: vi.fn(async () => [
    {
      currency: "EUR",
      exchange: "Irish",
      name: "Vanguard European Stock Index Fund Institutional EUR Accumulation",
      provider: "yahoo",
      quoteType: "MUTUALFUND",
      symbol: "IE0007987708.IR",
      isin: "IE0007987708",
    },
  ]),
}));

import SymbolSearch from "./symbol-search";

describe("SymbolSearch", () => {
  test("candidate links drop server-action and unrelated add-form GET noise", async () => {
    const element = await SymbolSearch({
      basePath: "/patrimonio/anadir",
      currentParams: {
        $ACTION_ID_606cd9876f9b2a87de3e8305691d4976b93ffe6529: "",
        instrument: "fund",
        name_current_account: "",
        name_etf: "",
        name_fund: "Vanguard European Stock Index Fund",
        ownershipPreset: "scope",
        price_fund: "",
        scopeMemberId: "mJ",
        symbol_fund: "",
        symbolq: ["IE0007987708.IR", "", "", ""],
        value_current_account: "",
      },
      pickedSymbol: undefined,
      query: "IE0007987708.IR",
    });

    const markup = renderToStaticMarkup(element);
    const decoded = decodeURIComponent(markup);

    expect(decoded).toContain("instrument=fund");
    expect(decoded).toContain("symbolq=IE0007987708.IR");
    expect(decoded).toContain("pfSymbol=IE0007987708.IR");
    expect(decoded).toContain("pfIsin=IE0007987708");
    expect(decoded).not.toContain("$ACTION_ID");
    expect(decoded).not.toContain("name_etf");
    expect(decoded).not.toContain("value_current_account");
  });
});
