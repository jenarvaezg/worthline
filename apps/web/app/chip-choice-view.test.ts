import { chipChoicesMarkedFirst } from "@web/chip-choice-view";
import type { ManualAsset } from "@worthline/domain";
import { describe, expect, test } from "vitest";

function asset(id: string, name: string): ManualAsset {
  return {
    currency: "EUR",
    currentValue: { amountMinor: 10_000_00, currency: "EUR" },
    id,
    isPrimaryResidence: false,
    liquidityTier: "term-locked",
    name,
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "investment",
  };
}

const options = [
  asset("etf1", "iShares"),
  asset("pp1", "MyInvestor PP"),
  asset("etf2", "Vanguard"),
  asset("pp2", "Plan de empleo"),
];

describe("chipChoicesMarkedFirst (#1483)", () => {
  test("los marcados salen primero: entre doce candidatos, los tres marcados se ahogaban", () => {
    const entries = chipChoicesMarkedFirst({ options, selectedIds: ["pp1", "pp2"] });

    expect(entries.map((entry) => entry.asset.id)).toEqual([
      "pp1",
      "pp2",
      "etf1",
      "etf2",
    ]);
    expect(entries.map((entry) => entry.checked)).toEqual([true, true, false, false]);
  });

  test("dentro de cada grupo se conserva el orden del catálogo", () => {
    // El orden lo pone el catálogo, no el orden en que se marcaron: la lista no
    // debe bailar entre dos cargas de la misma pantalla.
    const entries = chipChoicesMarkedFirst({ options, selectedIds: ["pp2", "pp1"] });

    expect(entries.map((entry) => entry.asset.id)).toEqual([
      "pp1",
      "pp2",
      "etf1",
      "etf2",
    ]);
  });

  test("sin nada marcado, el catálogo sale tal cual", () => {
    const entries = chipChoicesMarkedFirst({ options, selectedIds: [] });

    expect(entries.map((entry) => entry.asset.id)).toEqual([
      "etf1",
      "pp1",
      "etf2",
      "pp2",
    ]);
    expect(entries.every((entry) => !entry.checked)).toBe(true);
  });

  test("un id marcado que no está en la lista no inventa un chip", () => {
    const entries = chipChoicesMarkedFirst({
      options,
      selectedIds: ["pp1", "fantasma"],
    });

    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => entry.asset.id)).toEqual([
      "pp1",
      "etf1",
      "etf2",
      "pp2",
    ]);
  });
});
