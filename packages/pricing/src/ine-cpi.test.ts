import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { fetchSpanishCpi, INE_SPANISH_CPI_TABLE_ID } from "./ine-cpi";

describe("fetchSpanishCpi", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("fetches INE Spanish CPI and maps monthly rows to benchmark prices", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          COD: "IPC290751",
          Nombre: "Nacional. Índice general. Índice. ",
          Data: [
            { Anyo: 2025, FK_Periodo: 2, Valor: 118.473 },
            { Anyo: 2025, FK_Periodo: 1, Valor: 117.982 },
          ],
        },
      ],
    } as Response);

    await expect(fetchSpanishCpi()).resolves.toEqual([
      { dateKey: "2025-01-01", value: "117.982" },
      { dateKey: "2025-02-01", value: "118.473" },
    ]);
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe(
      `https://servicios.ine.es/wstempus/js/es/DATOS_TABLA/${INE_SPANISH_CPI_TABLE_ID}`,
    );
  });
});
