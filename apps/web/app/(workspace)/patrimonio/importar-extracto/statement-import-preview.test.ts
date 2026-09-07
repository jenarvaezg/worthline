import type { InvestmentOperation } from "@worthline/domain";
import { parseStatement } from "@worthline/domain";
import { describe, expect, test, vi } from "vitest";

import {
  readPortfolioInvestments,
  type StatementImportPreviewReadPort,
} from "./statement-import-preview";

/**
 * The two phases of the preview read (#1748). Which holdings a statement can reach
 * is decided by the identity columns; only those holdings' ledgers are read. The
 * test is about the READS, because the cost is invisible in the result: a preview
 * that folds the whole portfolio's operations returns exactly the same buckets.
 */
const FILE = [
  "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
  "05/01/2026;Plan de pensiones;N5394;Compra;34,2857;1200;;Plan Indexado",
].join("\r\n");

function parsed() {
  const result = parseStatement(FILE, "plantilla");
  if (!result.ok) throw new Error(result.errors.join(" | "));
  return result.value;
}

function port(
  metas: Awaited<
    ReturnType<StatementImportPreviewReadPort["readInvestmentAssetsWithMeta"]>
  >,
): { store: StatementImportPreviewReadPort; readOperations: ReturnType<typeof vi.fn> } {
  const readOperations = vi.fn(
    async (_assetId: string): Promise<InvestmentOperation[]> => [],
  );
  return {
    readOperations,
    store: {
      readInvestmentAssetsWithMeta: async () => metas,
      readOperations,
    },
  };
}

describe("readPortfolioInvestments — solo el libro de quien puede reclamar (#1748)", () => {
  test("lee las operaciones del plan que casa, y de nadie más", async () => {
    const { store, readOperations } = port([
      {
        id: "plan",
        instrument: "pension_plan",
        name: "Plan Indexado",
        securityId: { kind: "dgs", value: "N5394" },
      },
      { id: "fondo", instrument: "fund", name: "Fondo Ajeno" },
      { id: "cripto", instrument: "crypto", name: "Bitcoin", providerSymbol: "bitcoin" },
    ]);

    const investments = await readPortfolioInvestments(store, parsed());

    expect(investments.map((investment) => investment.assetId)).toEqual(["plan"]);
    expect(readOperations.mock.calls.map(([assetId]) => assetId)).toEqual(["plan"]);
  });

  test("el candidato del brazo débil también trae su libro: la fusión lo necesita", async () => {
    // Sin identificador declarado, pero con el nombre exacto y el instrumento: es a
    // quien el extracto ofrece su código, y su fusión se pinta en el preview.
    const { store, readOperations } = port([
      { id: "plan", instrument: "pension_plan", name: "Plan Indexado" },
      { id: "otro", instrument: "pension_plan", name: "Otro Plan" },
    ]);

    const investments = await readPortfolioInvestments(store, parsed());

    expect(investments.map((investment) => investment.assetId)).toEqual(["plan"]);
    expect(readOperations).toHaveBeenCalledTimes(1);
  });

  test("un fichero que no alcanza a nadie no lee ni un libro", async () => {
    const { store, readOperations } = port([
      { id: "fondo", instrument: "fund", name: "Fondo Ajeno" },
    ]);

    expect(await readPortfolioInvestments(store, parsed())).toEqual([]);
    expect(readOperations).not.toHaveBeenCalled();
  });
});
