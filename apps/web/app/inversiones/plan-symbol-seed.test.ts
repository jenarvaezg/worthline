import type { SymbolCandidate } from "@worthline/pricing";
import { describe, expect, test, vi } from "vitest";
import { resolvePlanSymbolFromDgs } from "./plan-symbol-seed";

const candidate: SymbolCandidate = {
  name: "MyInvestor S&P 500 PP",
  provider: "finect",
  quoteType: "PENSIONPLAN",
  symbol: "N5394-Myinvestor_indexado_sp_500_pp",
};

describe("resolvePlanSymbolFromDgs — the retry the health signal promises", () => {
  test("hands back the slug Finect resolved for the code", async () => {
    const search = vi.fn(async () => [candidate]);

    await expect(resolvePlanSymbolFromDgs(" N5394 ", search)).resolves.toBe(
      candidate.symbol,
    );
    expect(search).toHaveBeenCalledWith("N5394", "pension_plan");
  });

  test("Finect silent is null, never a throw: «identificado, sin cotizar» holds", async () => {
    await expect(resolvePlanSymbolFromDgs("N9999", async () => [])).resolves.toBeNull();
  });

  test("no code, no call — nothing to resolve", async () => {
    const search = vi.fn(async () => [candidate]);

    await expect(resolvePlanSymbolFromDgs("  ", search)).resolves.toBeNull();
    expect(search).not.toHaveBeenCalled();
  });
});
