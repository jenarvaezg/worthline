/**
 * La página de Conexiones (#1223, PRD #1222) se dibuja SOLA a partir del
 * registry: estos tests miran lo que el usuario ve —la fila de una fuente
 * conectada, el pliegue de una sin conectar y la banda de plan— sin nombrar ni
 * un bloque de JSX por adapter.
 */

import type { EntitlementPlan, SyncRun } from "@worthline/db";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  listSourceAssetIds: vi.fn(async () => ["asset_binance"]),
  // Annotated with the port's shape: a MyInvestor row has no mirror asset and
  // carries its credentials (#1879), which the inferred literal would refuse.
  listSources: vi.fn(
    async (): Promise<
      {
        id: string;
        adapter: string;
        assetId: string | null;
        credentialsJson?: string;
        label: string;
        lastSyncAt: string | null;
      }[]
    > => [
      {
        id: "src_binance",
        adapter: "binance",
        assetId: "asset_binance",
        label: "Binance",
        lastSyncAt: "2026-08-16T05:12:41.000Z",
      },
    ],
  ),
  plan: "premium" as EntitlementPlan,
  target: { kind: "authenticated", workspaceId: "wl_1" } as Record<string, unknown>,
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
  // La fuente está al día: es el caso corriente, y el que deja que los tests de
  // fallo hablen solo del eje que prueban.
  readSourceFreshness: vi.fn(
    async (): Promise<{ fetchedAt: string; freshnessState: string } | null> => ({
      fetchedAt: "2026-08-16T05:12:41.000Z",
      freshnessState: "fresh",
    }),
  ),
  // Anotada con el tipo del puerto, no inferida del literal: `vi.fn` estrecharía
  // `status: "ok"` y ningún `mockResolvedValueOnce` con otra corrida compilaría.
  readRuns: vi.fn(
    async (): Promise<SyncRun[]> => [
      {
        createdAt: "2026-08-16T05:12:37.000Z",
        error: null,
        finishedAt: "2026-08-16T05:12:41.000Z",
        id: "run_ok",
        sourceId: "src_binance",
        startedAt: "2026-08-16T05:12:37.000Z",
        status: "ok",
        trigger: "cron",
      },
    ],
  ),
}));

vi.mock("@web/page-shell", () => ({
  resolvePageShell: async () => ({
    privacyMode: false,
    store: {
      agentView: {
        readPublicIds: calls.readPublicIds,
        readSourceFreshness: calls.readSourceFreshness,
      },
      assets: { readAssets: calls.readAssets },
      connectedSources: {
        listSourceAssetIds: calls.listSourceAssetIds,
        listSources: calls.listSources,
        readPositions: calls.readPositions,
      },
      syncRuns: { readRuns: calls.readRuns },
    },
  }),
}));

vi.mock("@web/read-store-target", () => ({
  readSessionEmail: async () => null,
  readStoreTarget: async () => calls.target,
}));

// The page reads the relay's env after `connection()`, which has no request here.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
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
  calls.target = { kind: "authenticated", workspaceId: "wl_1" };
  vi.unstubAllEnvs();
});

/** The relay of ADR 0114 decision 10, configured (a fake URL; nothing is called). */
function withRelay(): void {
  vi.stubEnv("MYINVESTOR_RELAY_URL", "https://relay.example.com");
  vi.stubEnv("MYINVESTOR_RELAY_SECRET", "x".repeat(40));
}

/** The «Sin conectar» row of MyInvestor, cut out of the page. */
function myInvestorAvailableRow(html: string): string {
  const start = html.indexOf('<span class="conexName">MyInvestor</span>');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('<div class="conexAvailableRow"', start);
  return html.slice(start, end === -1 ? undefined : end);
}

const myInvestorSource = (credentialsJson: string) => ({
  adapter: "myinvestor",
  assetId: null,
  credentialsJson,
  id: "src_myinvestor",
  label: "MyInvestor",
  lastSyncAt: null,
});

describe("página de Conexiones (#1223)", () => {
  test("una fuente conectada es una fila con sus cifras y su enlace a la ficha", async () => {
    const html = await render();

    expect(html).toContain("Binance");
    // 1 token no polvo, valor agregado de los activos de la fuente.
    expect(html).toContain("Sincronizar Binance");
    expect(html).toContain("4812");
    expect(html).toContain("/patrimonio/wl_hld_binance/editar");
    expect(html).toContain("1 de 3 fuentes conectadas");
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

  test("una fuente sincronizada lo dice, con el trigger de su última corrida", async () => {
    const html = await render();

    expect(html).toContain("Sincronizado");
    expect(html).toContain("Automática");
  });

  test("sin ninguna fuente conectada la página lo dice y sigue ofreciendo conectar", async () => {
    calls.listSources.mockResolvedValueOnce([]);

    const html = await render();

    expect(html).toContain("No tienes ninguna fuente conectada");
    expect(html).toContain("Conectar Binance");
    expect(html).toContain("0 de 3 fuentes conectadas");
  });
});

describe("salud de sync visible (#1224)", () => {
  test("una fuente cuyo último sync falló lo dice, y explica por qué sin lenguaje de máquina", async () => {
    calls.readRuns.mockResolvedValueOnce([
      {
        createdAt: "2026-08-17T05:12:37.000Z",
        error: {
          code: "sync_persist_failed",
          message: "SQLITE_BUSY: database is locked at libsql://wl-524331371ead4320",
          retriable: true,
        },
        finishedAt: "2026-08-17T05:12:39.000Z",
        id: "run_error",
        sourceId: "src_binance",
        startedAt: "2026-08-17T05:12:37.000Z",
        status: "error",
        trigger: "manual",
      },
    ]);

    const html = await render();

    expect(html).toContain("Con error");
    // Con la FECHA del intento fallido: la columna «Última sincronización» sigue
    // clavada en el último sync bueno (16 ago), así que sin esto nadie sabría
    // desde cuándo lleva fallando.
    expect(html).toContain("La última sincronización falló el 17 ago 2026");
    expect(html).toContain("no pudo guardarlos");
    // El detalle crudo del error se queda en el log del servidor: nunca aquí.
    expect(html).not.toContain("SQLITE_BUSY");
    expect(html).not.toContain("libsql");
    expect(html).not.toContain("wl-524331371ead4320");
  });

  test("el fold de historial trae cuándo, con qué trigger y con qué resultado", async () => {
    calls.readRuns.mockResolvedValueOnce([
      {
        createdAt: "2026-08-17T05:12:37.000Z",
        error: { code: "sync_persist_failed", message: "boom", retriable: true },
        finishedAt: "2026-08-17T05:12:39.000Z",
        id: "run_error",
        sourceId: "src_binance",
        startedAt: "2026-08-17T05:12:37.000Z",
        status: "error",
        trigger: "manual",
      },
      {
        createdAt: "2026-08-16T05:12:37.000Z",
        error: null,
        finishedAt: "2026-08-16T05:12:41.000Z",
        id: "run_ok",
        sourceId: "src_binance",
        startedAt: "2026-08-16T05:12:37.000Z",
        status: "ok",
        trigger: "connect",
      },
    ]);

    const html = await render();

    expect(html).toContain("Historial de sincronización");
    expect(html).toContain("Manual");
    expect(html).toContain("Al conectar");
    expect(html).toContain("Correcta");
    // Las dos corridas, cada una con su fecha.
    expect(html).toContain("17 ago 2026");
    expect(html).toContain("16 ago 2026");
  });

  test("un sync en vuelo se lee como en curso, no como caído", async () => {
    calls.readRuns.mockResolvedValueOnce([
      {
        createdAt: "2026-08-17T05:12:37.000Z",
        error: null,
        finishedAt: null,
        id: "run_running",
        sourceId: "src_binance",
        startedAt: "2026-08-17T05:12:37.000Z",
        status: "running",
        trigger: "cron",
      },
    ]);

    const html = await render();

    expect(html).toContain("Sincronizando…");
    expect(html).not.toContain("La última sincronización falló");
  });

  test("una fuente que no consigue traer datos NO afirma salud, aunque su última corrida fuese buena", async () => {
    // El fallo de fetch —credenciales revocadas, proveedor caído— se captura aguas
    // arriba y no abre corrida: `sync_run` solo guarda la última corrida BUENA. Sin
    // leer la frescura, la fila pintaría verde «Sincronizado» con la fuente a
    // oscuras — y contradiría al bloque de salud del home, que sí lo ve.
    calls.readSourceFreshness.mockResolvedValueOnce({
      fetchedAt: "2026-08-17T21:00:00.000Z",
      freshnessState: "failed",
    });

    const html = await render();

    expect(html).toContain("Con error");
    expect(html).not.toContain("Sincronizado");
    expect(html).toContain("no consiguió traer");
    // Fechado por el intento de traída, no por la corrida buena del 16.
    expect(html).toContain("17 ago 2026");
  });

  test("una fuente rancia se dice desactualizada, que no es lo mismo que caída", async () => {
    calls.readSourceFreshness.mockResolvedValueOnce({
      fetchedAt: "2026-08-14T21:00:00.000Z",
      freshnessState: "stale",
    });

    const html = await render();

    expect(html).toContain("Desactualizado");
    expect(html).not.toContain("Con error");
    expect(html).not.toContain("La última sincronización falló");
  });

  test("una fuente sin corridas retenidas no finge salud ni abre un historial vacío", async () => {
    calls.readRuns.mockResolvedValueOnce([]);

    const html = await render();

    expect(html).toContain("Conectado");
    expect(html).not.toContain("Historial de sincronización");
    expect(html).not.toContain("La última sincronización falló");
  });
});

describe("editar credenciales sin desconectar (#1225)", () => {
  test("una fuente conectada trae su pliegue de credenciales, con los campos de su registry", async () => {
    const html = await render();

    expect(html).toContain("Cambiar credenciales");
    // Binance declara dos campos: los dos se piden aquí, sin JSX propio.
    expect(html).toContain("Clave de API de Binance");
    expect(html).toContain("Secreto de API de Binance");
    expect(html).toContain("Guardar las credenciales nuevas");
    // Y la promesa que sostiene todo el slice: nada se pisa hasta que el
    // proveedor acepte, así que cambiar la clave no cuesta el histórico.
    expect(html).toContain("las de ahora siguen intactas");
  });

  test("una fuente SIN conectar no ofrece cambiar credenciales: no tiene ninguna", async () => {
    calls.listSources.mockResolvedValueOnce([]);

    const html = await render();

    expect(html).not.toContain("Cambiar credenciales");
    expect(html).toContain("Conectar Binance");
  });

  test("los campos del pliegue de cambio son secretos, como los de conectar", async () => {
    const html = await render();

    // Binance conectado (2 campos de cambio) + Numista sin conectar (1 de
    // conexión): los tres, y los tres `type="password"`.
    const credentialInputs = html.match(/<input[^>]*name="api[A-Za-z]*"[^>]*>/g) ?? [];
    expect(credentialInputs).toHaveLength(3);
    for (const input of credentialInputs) {
      expect(input).toContain('type="password"');
    }
  });

  test("un error al cambiar credenciales reabre ESE pliegue, no el de conectar", async () => {
    const html = renderToStaticMarkup(
      await ConexionesContent({
        searchParams: Promise.resolve({
          error: "Binance rechazó esas credenciales, así que no se ha guardado nada.",
          form: "binance-credentials",
        }),
      }),
    );

    // Exactamente un pliegue abierto, y es el de credenciales: el de conectar
    // Numista sigue cerrado (su formulario no se envió).
    expect(html.match(/<details[^>]*\sopen=""/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/<details class="conexCredentials"[^>]*open=""/);
    expect(html).toContain("rechazó esas credenciales");
  });

  test("un error de conexión NO reabre el pliegue de credenciales de otra fila", async () => {
    const html = renderToStaticMarkup(
      await ConexionesContent({
        searchParams: Promise.resolve({
          error: "Pega tu clave de API de Numista para conectar la colección.",
          form: "numista",
        }),
      }),
    );

    expect(html.match(/<details[^>]*\sopen=""/g) ?? []).toHaveLength(1);
    expect(html).not.toMatch(/<details class="conexCredentials"[^>]*open=""/);
  });
});

describe("MyInvestor en Conexiones (#1879, variante A)", () => {
  test("sin el relé configurado, la fila dice en una línea que no se puede conectar", async () => {
    const row = myInvestorAvailableRow(await render());

    expect(row).toContain("Conectar MyInvestor aún no está disponible en este servidor.");
    expect(row).not.toContain("<details");
  });

  test("con el relé y premium, el pliegue trae usuario, contraseña, el aviso entero y después la casilla", async () => {
    withRelay();

    const row = myInvestorAvailableRow(await render());

    expect(row).toContain('<details class="conexConnect"');
    expect(row).toContain("Usuario (DNI o NIE)");
    expect(row).toMatch(/<input[^>]*type="password"[^>]*name="password"/);
    // El texto literal de ADR 0114 decisión 1, entero y fuera de cualquier pliegue
    // propio: el único <details> de la fila es el de «Conectar».
    expect(row).toContain(
      "Las órdenes y las transferencias siguen necesitando tu firma en el móvil: no apruebes nunca una notificación que no hayas pedido tú.",
    );
    expect(row.match(/<details/g)).toHaveLength(1);
    // Se lee antes de marcar: el aviso va antes que la casilla, y la casilla sale
    // desmarcada.
    const notice = row.indexOf("Guardar la contraseña permite");
    const box = row.indexOf('name="savePassword"');
    expect(notice).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(notice);
    expect(row).not.toMatch(/name="savePassword"[^>]*checked/);
    expect(row).toContain("Entiendo el riesgo y lo asumo.");
    expect(row).toContain("guarda solo la marca de este dispositivo");
    expect(row).toContain("Conectar MyInvestor");
  });

  test("sin premium, la fila dice que es premium con su enlace, sin pliegue", async () => {
    withRelay();
    calls.plan = "free";

    const row = myInvestorAvailableRow(await render());

    expect(row).toContain("Conectar MyInvestor es premium.");
    expect(row).toContain('href="/premium"');
    expect(row).not.toContain("<details");
  });

  test("con permiso de solo lectura, la fila lo dice, sin pliegue", async () => {
    withRelay();
    calls.target = { kind: "demo", now: "", persona: "familia" };

    const row = myInvestorAvailableRow(await render());

    expect(row).toContain(
      "Conectar una fuente necesita permiso para editar este workspace.",
    );
    expect(row).not.toContain("<details");
  });

  test("conectada sin contraseña: falta elegir qué incluir, se pone al día cuando pulses", async () => {
    calls.listSources.mockResolvedValueOnce([
      myInvestorSource(JSON.stringify({ deviceId: "device-1" })),
    ]);
    calls.listSourceAssetIds.mockResolvedValueOnce([]);

    const html = await render();

    expect(html).toContain("Falta elegir qué incluir");
    expect(html).toContain("Se pone al día cuando pulses");
    expect(html).toContain("Ponerse al día sola cada día");
    expect(html).toContain("Guardar la contraseña");
    expect(html).toContain("Desconectar MyInvestor");
    expect(html).toContain("1 de 3 fuentes conectadas");
  });

  test("conectada con la contraseña guardada: cuándo, quién y cómo dejar de guardarla", async () => {
    calls.listSources.mockResolvedValueOnce([
      myInvestorSource(
        JSON.stringify({
          acceptance: { acceptedAt: "2026-11-04T11:00:00.000Z", acceptedBy: null },
          customerId: "12345678A",
          deviceId: "device-1",
          password: "pw-que-no-se-pinta",
        }),
      ),
    ]);
    calls.listSourceAssetIds.mockResolvedValueOnce([]);

    const html = await render();

    expect(html).toContain("Se pone al día sola cada día");
    expect(html).toContain("Contraseña guardada");
    expect(html).toContain("La aceptaste tú.");
    expect(html).toContain("Dejar de guardarla");
    // La contraseña nunca se pinta, ni siquiera dentro de su pliegue.
    expect(html).not.toContain("pw-que-no-se-pinta");
    expect(html).not.toContain("12345678A");
  });
});
