/**
 * La página de Conexiones (#1223, PRD #1222) se dibuja SOLA a partir del
 * registry: estos tests miran lo que el usuario ve —la fila de una fuente
 * conectada, el pliegue de una sin conectar y la banda de plan— sin nombrar ni
 * un bloque de JSX por adapter.
 */

import type { EntitlementPlan } from "@worthline/db";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  listSourceAssetIds: vi.fn(async () => ["asset_binance"]),
  listSources: vi.fn(async () => [
    {
      id: "src_binance",
      adapter: "binance",
      assetId: "asset_binance",
      label: "Binance",
      lastSyncAt: "2026-08-16T05:12:41.000Z",
    },
  ]),
  plan: "premium" as EntitlementPlan,
  readAssets: vi.fn(async () => [
    {
      id: "asset_binance",
      name: "Binance",
      type: "investment",
      currency: "EUR",
      currentValue: { amountMinor: 481_233, currency: "EUR" },
      liquidityTier: "market",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      isPrimaryResidence: false,
    },
  ]),
  readPositions: vi.fn(async () => [
    {
      kind: "token",
      id: "BTC-spot",
      sourceId: "src_binance",
      externalId: "BTC:spot",
      name: "BTC",
      liquidityTier: "market",
      currency: "EUR",
      symbol: "BTC",
      balance: "0.5",
      wallet: "spot",
      unitPrice: "9624.66",
      imageUrl: null,
    },
  ]),
  readPublicIds: vi.fn(async () => [
    { entityType: "holding", entityId: "asset_binance", publicId: "wl_hld_binance" },
  ]),
}));

vi.mock("@web/page-shell", () => ({
  resolvePageShell: async () => ({
    privacyMode: false,
    store: {
      agentView: { readPublicIds: calls.readPublicIds },
      assets: { readAssets: calls.readAssets },
      connectedSources: {
        listSourceAssetIds: calls.listSourceAssetIds,
        listSources: calls.listSources,
        readPositions: calls.readPositions,
      },
    },
  }),
}));

vi.mock("@web/read-store-target", () => ({
  readStoreTarget: async () => ({ kind: "authenticated", workspaceId: "wl_1" }),
}));

vi.mock("@web/entitlements/read-effective-plan", () => ({
  readEffectivePlan: async () => calls.plan,
}));

import { ConexionesContent } from "./page";

async function render(): Promise<string> {
  return renderToStaticMarkup(
    await ConexionesContent({ searchParams: Promise.resolve({}) }),
  );
}

beforeEach(() => {
  calls.plan = "premium";
});

describe("página de Conexiones (#1223)", () => {
  test("una fuente conectada es una fila con sus cifras y su enlace a la ficha", async () => {
    const html = await render();

    expect(html).toContain("Binance");
    // 1 token no polvo, valor agregado de los activos de la fuente.
    expect(html).toContain("Sincronizar Binance");
    expect(html).toContain("4812");
    expect(html).toContain("/patrimonio/wl_hld_binance/editar");
    expect(html).toContain("1 de 2 fuentes conectadas");
  });

  test("bajo la misma fila cuelga el pliegue de desconexión, sin navegar", async () => {
    const html = await render();

    expect(html).toContain("Convertir en activo manual");
    expect(html).toContain("Eliminar y conservar histórico");
  });

  test("un adapter sin conectar ofrece los campos que declara su registry", async () => {
    const html = await render();

    expect(html).toContain("Sin conectar");
    expect(html).toContain("Clave de API de Numista");
    expect(html).toContain("Conectar Numista");
  });

  test("toda credencial del registry se pinta como secreto, nunca en claro", async () => {
    calls.listSources.mockResolvedValueOnce([]);

    const html = await render();

    // Numista (1 campo) + Binance (2): los tres, y los tres `type="password"`.
    const credentialInputs = html.match(/<input[^>]*name="api[A-Za-z]*"[^>]*>/g) ?? [];
    expect(credentialInputs).toHaveLength(3);
    for (const input of credentialInputs) {
      expect(input).toContain('type="password"');
    }
  });

  test("un error de conexión reabre el pliegue del adapter que lo produjo", async () => {
    const html = renderToStaticMarkup(
      await ConexionesContent({
        searchParams: Promise.resolve({
          error: "Pega tu clave de API de Numista para conectar la colección.",
          form: "numista",
        }),
      }),
    );

    // El pliegue de Numista viene abierto; el de Binance no existe aquí (está
    // conectado), así que basta con que haya exactamente un <details open>.
    expect(html.match(/<details[^>]*\sopen=""/g) ?? []).toHaveLength(1);
    expect(html).toContain("Pega tu clave de API de Numista");
  });

  test("un workspace free ve la pausa honesta, no un muro", async () => {
    calls.plan = "free";

    const html = await render();

    expect(html).toContain("premiumNotice");
    // Y la tabla sigue ahí: la lectura nunca se tapa.
    expect(html).toContain("Sincronizar Binance");
  });

  test("sin ninguna fuente conectada la página lo dice y sigue ofreciendo conectar", async () => {
    calls.listSources.mockResolvedValueOnce([]);

    const html = await render();

    expect(html).toContain("No tienes ninguna fuente conectada");
    expect(html).toContain("Conectar Binance");
    expect(html).toContain("0 de 2 fuentes conectadas");
  });
});
