/**
 * «El código siembra la búsqueda» (variante A de #1669) y, sobre todo, lo que pasa
 * cuando Finect no contesta: el alta NO se bloquea.
 */

import type { SymbolCandidate } from "@worthline/pricing";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const pricing = vi.hoisted(() => ({
  fetchPriceNow: vi.fn(async () => null),
  isRegisteredSource: vi.fn(() => false),
  searchSymbols: vi.fn(async (): Promise<SymbolCandidate[]> => []),
}));

vi.mock("@worthline/pricing", () => pricing);

import { loadPlanSearch } from "./_families/investment-pane";
import { PlanSearchResult } from "./plan-search";

const CANDIDATE: SymbolCandidate = {
  currency: "EUR",
  name: "MyInvestor S&P 500 PP",
  provider: "finect",
  quoteType: "PENSIONPLAN",
  symbol: "N5394-Myinvestor_indexado_sp_500_pp",
};

describe("loadPlanSearch — la llamada la paga la página, y solo cuando hay código", () => {
  beforeEach(() => {
    pricing.searchSymbols.mockReset();
    pricing.searchSymbols.mockResolvedValue([]);
  });

  test("resuelve el código contra el proveedor del plan", async () => {
    pricing.searchSymbols.mockResolvedValue([CANDIDATE]);

    const state = await loadPlanSearch({
      resolvedParams: { securityId_pension_plan: "N5394" },
      selectedDrawer: "inversion",
      selectedInstrument: "pension_plan",
    });

    expect(state).toEqual({ candidate: CANDIDATE, code: "N5394" });
    expect(pricing.searchSymbols).toHaveBeenCalledWith("N5394", "pension_plan");
  });

  test("busca por el código canónico, aunque el papel lo imprima con guion", async () => {
    pricing.searchSymbols.mockResolvedValue([CANDIDATE]);

    const state = await loadPlanSearch({
      resolvedParams: { securityId_pension_plan: "n-5394" },
      selectedDrawer: "inversion",
      selectedInstrument: "pension_plan",
    });

    // El lector de Finect distingue código de slug por la forma: «n-5394» no casa
    // con ninguna de las dos, y sin normalizar la búsqueda no encontraba nada.
    expect(pricing.searchSymbols).toHaveBeenCalledWith("N5394", "pension_plan");
    // Lo que se enseña sigue siendo lo que el usuario escribió.
    expect(state?.code).toBe("n-5394");
  });

  test("lo que no es un código viaja tal cual: un slug o una URL de Finect lo son", async () => {
    pricing.searchSymbols.mockResolvedValue([CANDIDATE]);

    await loadPlanSearch({
      resolvedParams: {
        securityId_pension_plan: "N5394-Myinvestor_indexado_sp_500_pp",
      },
      selectedDrawer: "inversion",
      selectedInstrument: "pension_plan",
    });

    expect(pricing.searchSymbols).toHaveBeenCalledWith(
      "N5394-Myinvestor_indexado_sp_500_pp",
      "pension_plan",
    );
  });

  test("un render cualquiera del alta no paga red: sin código no hay búsqueda", async () => {
    const state = await loadPlanSearch({
      resolvedParams: {},
      selectedDrawer: "inversion",
      selectedInstrument: "pension_plan",
    });

    expect(state).toBeNull();
    expect(pricing.searchSymbols).not.toHaveBeenCalled();
  });

  test("Finect caído o un código que no existe es «sin candidato», nunca un error", async () => {
    const state = await loadPlanSearch({
      resolvedParams: { securityId_pension_plan: "N9999" },
      selectedDrawer: "inversion",
      selectedInstrument: "pension_plan",
    });

    expect(state).toEqual({ candidate: null, code: "N9999" });
  });

  test("los grupos que teclean su símbolo no pasan por aquí", async () => {
    const state = await loadPlanSearch({
      resolvedParams: { securityId_fund: "IE00B52MJY50" },
      selectedDrawer: "inversion",
      selectedInstrument: "fund",
    });

    expect(state).toBeNull();
    expect(pricing.searchSymbols).not.toHaveBeenCalled();
  });

  test("otro cajón abierto, ninguna búsqueda", async () => {
    const state = await loadPlanSearch({
      resolvedParams: { securityId_pension_plan: "N5394" },
      selectedDrawer: "deuda",
      selectedInstrument: "pension_plan",
    });

    expect(state).toBeNull();
  });
});

describe("PlanSearchResult — elegir el candidato es una navegación", () => {
  test("el enlace prellena nombre y símbolo, y conserva el código tecleado", () => {
    const markup = renderToStaticMarkup(
      <PlanSearchResult
        basePath="/patrimonio/anadir"
        currentParams={{
          instrument: "pension_plan",
          securityId_pension_plan: "N5394",
          simpleDrawer: "inversion",
        }}
        state={{ candidate: CANDIDATE, code: "N5394" }}
      />,
    );

    expect(markup).toContain("pfSymbol=N5394-Myinvestor_indexado_sp_500_pp");
    expect(markup).toContain("pfName=MyInvestor");
    expect(markup).toContain("securityId_pension_plan=N5394");
    // Un plan no tiene ISIN: nada puede prellenar el campo de identidad con uno.
    expect(markup).not.toContain("pfIsin");
    expect(markup).toContain("Finect");
  });

  test("sin candidato, lo que se lee es la salida: guardar igual y reintentar", () => {
    const markup = renderToStaticMarkup(
      <PlanSearchResult
        basePath="/patrimonio/anadir"
        currentParams={{ instrument: "pension_plan" }}
        state={{ candidate: null, code: "N9999" }}
      />,
    );

    expect(markup).toContain("N9999");
    expect(markup).toContain("guárdalo igual");
    // «Identificado, sin cotizar» es un estado legítimo con reintento desde la ficha.
    expect(markup).toContain("sin cotizar");
    expect(markup).toContain("reintentar");
  });
});
