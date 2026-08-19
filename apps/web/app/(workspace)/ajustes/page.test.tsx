import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

interface SourceRow {
  id: string;
  adapter: string;
  assetId: string;
  label: string;
  lastSyncAt: string | null;
}

const calls = vi.hoisted(() => ({
  listSources: vi.fn(async (): Promise<SourceRow[]> => []),
  readAssets: vi.fn(async () => [
    {
      id: "asset_cash",
      name: "Caja",
      type: "cash",
      currency: "EUR",
      currentValue: { amountMinor: 100_00, currency: "EUR" },
      liquidityTier: "cash",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      isPrimaryResidence: false,
    },
  ]),
  readFireConfig: vi.fn(async () => ({})),
  readOperations: vi.fn(async () => []),
  readPositions: vi.fn(async () => []),
  readPublicIds: vi.fn(async () => []),
  readSourceAssetIds: vi.fn(async () => []),
  readWarningOverrides: vi.fn(async () => []),
  readWorkspace: vi.fn(async () => ({
    baseCurrency: "EUR",
    groups: [],
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  })),
  resolvePageShell: vi.fn(async () => {
    const scopes = [{ id: "household", label: "Hogar", type: "household" }];
    return {
      persistence: {
        status: "ok",
        checkKey: "bootstrap.last_healthcheck_at",
        checkedAt: "2026-06-27T00:00:00.000Z",
        checkValue: "2026-06-27T00:00:00.000Z",
        databasePath: ":memory:",
        displayPath: ":memory:",
      },
      privacyMode: false,
      requestedScopeId: undefined,
      scopes,
      selectedScope: scopes[0],
      store: {
        agentView: { readPublicIds: calls.readPublicIds },
        assets: { readAssets: calls.readAssets },
        connectedSources: {
          listSources: calls.listSources,
          listSourceAssetIds: calls.readSourceAssetIds,
          readPositions: calls.readPositions,
        },
        operations: { readOperations: calls.readOperations },
        readFireConfig: calls.readFireConfig,
        readWarningOverrides: calls.readWarningOverrides,
      },
      target: { kind: "local" },
      workspace: await calls.readWorkspace(),
    };
  }),
}));

vi.mock("@web/page-shell", () => ({
  resolvePageShell: calls.resolvePageShell,
}));

vi.mock("@web/demo/write-guard", () => ({ isDemoMode: async () => false }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirected to ${url}`);
  },
}));

import { AjustesContent } from "./page";

describe("ajustes page data loading (#636)", () => {
  test("reuses store reads across the page render", async () => {
    await AjustesContent({ searchParams: Promise.resolve({}) });

    expect(calls.resolvePageShell).toHaveBeenCalledTimes(1);
    expect(calls.listSources).toHaveBeenCalledTimes(1);
    expect(calls.readAssets).toHaveBeenCalledTimes(1);
    expect(calls.readWarningOverrides).toHaveBeenCalledTimes(1);
  });
});

describe("la configuración FIRE se mudó a /objetivos (#1450)", () => {
  test("no queda formulario de supuestos aquí: una sola fuente, no dos", async () => {
    const html = renderToStaticMarkup(
      await AjustesContent({ searchParams: Promise.resolve({}) }),
    );

    expect(html).not.toContain("Configuración FIRE");
    for (const gone of [
      'name="monthlySpending"',
      'name="safeWithdrawalRate"',
      'name="monthlySavingsCapacity"',
      'name="targetRetirementAge"',
      'name="expectedRealReturn"',
      'name="leanMultiplier"',
      'name="baristaIncome"',
    ]) {
      expect(html).not.toContain(gone);
    }
  });

  test("ni cicatriz: aquí no queda ni la palabra FIRE", async () => {
    // Una mudanza no deja un aviso donde estaba el mueble. Los supuestos viven en
    // /objetivos y esta pantalla no vuelve a hablar de ellos.
    const html = renderToStaticMarkup(
      await AjustesContent({ searchParams: Promise.resolve({}) }),
    );

    expect(html).not.toContain("FIRE");
    expect(html).not.toContain("supuestos");
  });

  test("el año de nacimiento SÍ se queda: es del miembro, no del FIRE (#1415)", async () => {
    const html = renderToStaticMarkup(
      await AjustesContent({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain('name="birthMonth"');
    expect(html).toContain("Mes de nacimiento");
    expect(html).not.toContain('name="currentAge"');
  });

  test("y con el formulario se va su lectura de operaciones", async () => {
    // La sugerencia de ahorro por histórico (#425) leía las operaciones de cada
    // holding de inversión para pintar un placeholder: sin formulario, esta
    // página deja de pagar ese recorrido.
    await AjustesContent({ searchParams: Promise.resolve({}) });

    expect(calls.readOperations).not.toHaveBeenCalled();
  });
});

describe("las fuentes conectadas ya no viven aquí (#1223)", () => {
  test("la sección es una tarjeta-resumen: ni conectar, ni sincronizar, ni desconectar", async () => {
    calls.listSources.mockResolvedValueOnce([
      {
        id: "src_numista",
        adapter: "numista",
        assetId: "asset_numista",
        label: "Colección Numista",
        lastSyncAt: "2026-08-16T05:12:41.000Z",
      },
    ]);

    const html = renderToStaticMarkup(
      await AjustesContent({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain("/ajustes/conexiones");
    expect(html).toContain("1 de 2 conectadas");
    for (const gone of [
      "Conectar Numista",
      "Conectar Binance",
      "Sincronizar Numista",
      "Sincronizar Binance",
      "Clave de API de Numista",
      "Clave de API de Binance",
    ]) {
      expect(html).not.toContain(gone);
    }
  });

  test("no se leen posiciones ni activos de la fuente para pintar el resumen", async () => {
    await AjustesContent({ searchParams: Promise.resolve({}) });

    expect(calls.readPositions).not.toHaveBeenCalled();
    expect(calls.readSourceAssetIds).not.toHaveBeenCalled();
    expect(calls.readPublicIds).not.toHaveBeenCalled();
  });
});
