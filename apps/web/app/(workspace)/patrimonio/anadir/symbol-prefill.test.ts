import { describe, expect, test } from "vitest";
import { symbolPrefillHref } from "./symbol-prefill";

describe("symbolPrefillHref — picking a candidate is a navigation", () => {
  test("carries the alta's typed state alongside the candidate's own fields", () => {
    const href = symbolPrefillHref({
      basePath: "/patrimonio/anadir",
      candidate: {
        isin: "IE00B52MJY50",
        name: "iShares Core S&P 500",
        provider: "yahoo",
        symbol: "SXR8.DE",
      },
      preservedParams: {
        instrument: "fund",
        saldo_fund: "1000",
        simpleDrawer: "inversion",
      },
      query: "S&P 500",
    });

    const params = new URL(href, "https://x.test").searchParams;
    expect(params.get("saldo_fund")).toBe("1000");
    expect(params.get("simpleDrawer")).toBe("inversion");
    expect(params.get("symbolq")).toBe("S&P 500");
    expect(params.get("pfSymbol")).toBe("SXR8.DE");
    expect(params.get("pfName")).toBe("iShares Core S&P 500");
    expect(params.get("pfProvider")).toBe("yahoo");
    expect(params.get("pfIsin")).toBe("IE00B52MJY50");
  });

  test("no query, no `symbolq` — the plan's search box IS the identifier field", () => {
    const href = symbolPrefillHref({
      basePath: "/patrimonio/anadir",
      candidate: {
        name: "MyInvestor S&P 500 PP",
        provider: "finect",
        symbol: "N5394-Myinvestor_indexado_sp_500_pp",
      },
      preservedParams: { instrument: "pension_plan", securityId_pension_plan: "N5394" },
    });

    const params = new URL(href, "https://x.test").searchParams;
    expect(params.has("symbolq")).toBe(false);
    expect(params.has("pfIsin")).toBe(false);
    // The code the user typed survives the pick: it is what the alta will store.
    expect(params.get("securityId_pension_plan")).toBe("N5394");
    expect(params.get("pfSymbol")).toBe("N5394-Myinvestor_indexado_sp_500_pp");
  });

  test("a multi-valued preserved param keeps every value (custom ownership split)", () => {
    const href = symbolPrefillHref({
      basePath: "/patrimonio/anadir",
      candidate: { name: "ACME", provider: "yahoo", symbol: "ACME" },
      preservedParams: { owner_member: ["50", "50"] },
    });

    expect(new URL(href, "https://x.test").searchParams.getAll("owner_member")).toEqual([
      "50",
      "50",
    ]);
  });
});
