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

describe("la edad del FIRE ya no se teclea (#1415)", () => {
  test("el panel FIRE no ofrece campo de edad y el perfil pide mes de nacimiento", async () => {
    const html = renderToStaticMarkup(
      await AjustesContent({ searchParams: Promise.resolve({}) }),
    );

    expect(html).not.toContain('name="currentAge"');
    expect(html).not.toContain("Edad actual");
    expect(html).toContain('name="birthMonth"');
    expect(html).toContain("Mes de nacimiento");
    // La edad objetivo sí sigue siendo una elección del usuario.
    expect(html).toContain('name="targetRetirementAge"');
  });

  test("sin fecha de nacimiento avisa de que el coast se queda fuera", async () => {
    // El miembro del mock no tiene año de nacimiento: sin él no hay edad, y sin
    // edad calculateFire se salta el bloque de coast sin decir nada.
    const html = renderToStaticMarkup(
      await AjustesContent({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain("Sin fecha de nacimiento no hay edad actual");
  });

  test("una edad heredada de la configuración vieja se declara congelada", async () => {
    calls.readFireConfig.mockResolvedValueOnce({
      household: {
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.04,
        currentAge: 48,
        excludedAssetIds: [],
      },
    });

    const html = renderToStaticMarkup(
      await AjustesContent({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain("(48)");
    expect(html).toContain("no se actualiza sola");
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
