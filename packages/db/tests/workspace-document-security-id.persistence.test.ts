/**
 * El identificador de valor cruzando la puerta del documento de workspace
 * (#1743, resolución #1667 puntos 4 y 5).
 *
 * Dos lectores, una puerta (ADR 0071): el documento nuevo trae el par
 * `securityId` + `securityIdKind`, y el campo legacy `isin` se sigue aceptando
 * PARA SIEMPRE — un fichero escrito por cualquier versión pasada tiene que seguir
 * restaurando. Se descartó conservar `isin` como nombre de salida: perpetuarlo
 * perpetuaría la mentira que originó el mapa (un plan de pensiones no tiene ISIN).
 *
 * Y por encima de todo, #1416: el restore PRESERVA, nunca deriva, y no puede
 * fallar. El valor entra por un clasificador total —clasifica por forma y guarda
 * verbatim lo que no sabe nombrar— así que este es el ÚNICO camino del que puede
 * nacer una fila con `security_id` puesto y `security_id_kind` a null.
 */
import { createInMemoryStore } from "@db/index";
import type { WorkspaceExport } from "@worthline/domain";
import { serializeWorkspaceExport } from "@worthline/domain";
import { describe, expect, test } from "vitest";

/** Un documento mínimo con UNA inversión y los metadatos que se le pasen. */
function documentWithInvestment(investment: Record<string, unknown>): WorkspaceExport {
  return serializeWorkspaceExport({
    workspace: { mode: "individual", baseCurrency: "EUR" },
    members: [{ id: "m1", name: "Jorge" }],
    groups: [],
    assets: [
      {
        id: "a1",
        name: "Plan de pensiones",
        type: "investment",
        currency: "EUR",
        liquidityTier: "term-locked",
        isPrimaryResidence: false,
        ownership: [{ memberId: "m1", shareBps: 10000 }],
        investment,
      },
    ],
    liabilities: [],
    operations: [],
    warningOverrides: [],
    fireConfig: {},
    snapshots: [],
    trash: { assets: [], liabilities: [] },
    priceCache: [],
    connectedSources: [],
  });
}

async function importAndRead(investment: Record<string, unknown>) {
  const store = await createInMemoryStore();
  try {
    await store.workspace.importWorkspace(documentWithInvestment(investment));
    return await store.assets.readInvestmentAssetById("a1");
  } finally {
    store.close();
  }
}

describe("el identificador de valor en el documento de workspace (#1743)", () => {
  test("el documento nuevo entra con su par tal cual", async () => {
    const row = await importAndRead({
      securityId: "N5394",
      securityIdKind: "dgs",
    });

    expect(row?.securityId).toEqual({ kind: "dgs", value: "N5394" });
  });

  test("el campo legacy `isin` se sigue leyendo, y un ISIN llega tipado", async () => {
    const row = await importAndRead({ isin: "IE00BK5BQT80" });

    expect(row?.securityId).toEqual({ kind: "isin", value: "IE00BK5BQT80" });
  });

  // El caso que motivó el mapa: el código del plan viajaba en un campo llamado
  // `isin`. Al entrar se clasifica por forma y deja de mentir sobre lo que es.
  test("un código DGS guardado en el campo legacy entra como lo que es", async () => {
    const row = await importAndRead({ isin: "N5394" });

    expect(row?.securityId).toEqual({ kind: "dgs", value: "N5394" });
  });

  test("lo irreconocible se preserva sin clase y el restore NO falla (#1416)", async () => {
    const row = await importAndRead({ isin: "esto-no-es-un-identificador" });

    expect(row?.securityId).toEqual({
      kind: null,
      value: "esto-no-es-un-identificador",
    });
  });

  test("el par gana al campo legacy cuando el documento trae los dos", async () => {
    const row = await importAndRead({
      isin: "IE00BK5BQT80",
      securityId: "N5394",
      securityIdKind: "dgs",
    });

    expect(row?.securityId).toEqual({ kind: "dgs", value: "N5394" });
  });

  test("el export escribe el par y ya no el nombre viejo", async () => {
    const store = await createInMemoryStore();
    try {
      await store.workspace.importWorkspace(
        documentWithInvestment({ isin: "N5394", providerSymbol: "N5394-Myinvestor" }),
      );

      const exported = await store.workspace.exportWorkspace();
      const investment = exported.assets.find((asset) => asset.id === "a1")?.investment;

      expect(investment).toMatchObject({
        securityId: "N5394",
        securityIdKind: "dgs",
      });
      expect(investment).not.toHaveProperty("isin");
    } finally {
      store.close();
    }
  });

  test("un valor preservado sin clase sobrevive la ida y la vuelta completa", async () => {
    const store = await createInMemoryStore();
    try {
      await store.workspace.importWorkspace(
        documentWithInvestment({ isin: "esto-no-es-un-identificador" }),
      );
      const exported = await store.workspace.exportWorkspace();

      const second = await createInMemoryStore();
      try {
        await second.workspace.importWorkspace(exported);
        expect((await second.assets.readInvestmentAssetById("a1"))?.securityId).toEqual({
          kind: null,
          value: "esto-no-es-un-identificador",
        });
      } finally {
        second.close();
      }
    } finally {
      store.close();
    }
  });
});
