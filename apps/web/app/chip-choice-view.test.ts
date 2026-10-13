import {
  chipChoiceMode,
  chipChoicesMarkedFirst,
  chipChoiceTwinCodes,
} from "@web/chip-choice-view";
import type { ManualAsset } from "@worthline/domain";
import { describe, expect, test } from "vitest";

function asset(id: string, name: string, extra: Partial<ManualAsset> = {}): ManualAsset {
  return {
    currency: "EUR",
    currentValue: { amountMinor: 10_000_00, currency: "EUR" },
    id,
    isPrimaryResidence: false,
    liquidityTier: "term-locked",
    name,
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "investment",
    ...extra,
  };
}

describe("chipChoiceMode (#1837)", () => {
  test("hasta doce opciones caben como chips; la decimotercera abre el libro", () => {
    expect(chipChoiceMode(0)).toBe("chips");
    expect(chipChoiceMode(12)).toBe("chips");
    expect(chipChoiceMode(13)).toBe("ledger");
    expect(chipChoiceMode(80)).toBe("ledger");
  });
});

describe("chipChoiceTwinCodes (#1837)", () => {
  test("dos activos con el mismo nombre llevan cada uno su ISIN o código DGS", () => {
    const codes = chipChoiceTwinCodes([
      asset("acc", "Fidelity MSCI World Index Fund", {
        securityId: { kind: "isin", value: "IE00BYX5NX33" },
      }),
      asset("dist", "Fidelity MSCI World Index Fund", {
        securityId: { kind: "isin", value: "IE00BYX5MX67" },
      }),
      asset("plan", "Indexa Más Rentabilidad Acciones PP", {
        securityId: { kind: "dgs", value: "N5396" },
      }),
    ]);

    expect(codes).toEqual(
      new Map([
        ["acc", "IE00BYX5NX33"],
        ["dist", "IE00BYX5MX67"],
      ]),
    );
  });

  test("sin ISIN ni código, el gemelo se distingue por su símbolo", () => {
    const codes = chipChoiceTwinCodes([
      asset("lse", "iShares Core MSCI World", { providerSymbol: "SWDA.L" }),
      asset("ams", "iShares Core MSCI World", {
        providerSymbol: "IWDA.AS",
        securityId: { kind: "isin", value: "IE00B4L5Y983" },
      }),
    ]);

    expect(codes.get("lse")).toBe("SWDA.L");
    // El ISIN gana al símbolo: es la identidad, el símbolo solo una cotización.
    expect(codes.get("ams")).toBe("IE00B4L5Y983");
  });

  test("el nombre se compara como se lee: sin mayúsculas, tildes ni espacios de más", () => {
    const codes = chipChoiceTwinCodes([
      asset("a", "Telefónica", { providerSymbol: "TEF.MC" }),
      asset("b", " telefonica", { providerSymbol: "TEF.DE" }),
    ]);

    expect([...codes.keys()]).toEqual(["a", "b"]);
  });

  test("un gemelo sin nada que lo distinga no inventa un código", () => {
    const codes = chipChoiceTwinCodes([
      asset("c1", "Cuenta corriente", { type: "cash" }),
      asset("c2", "Cuenta corriente", { type: "cash" }),
    ]);

    expect(codes.size).toBe(0);
  });
});

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
