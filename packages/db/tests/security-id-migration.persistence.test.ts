/**
 * Schema migration v70 (#1743, slice 2 del PRD #1741): la columna `isin` se
 * generaliza al par `security_id` + `security_id_kind`.
 *
 * Un plan de pensiones español NO tiene ISIN — su identificador es el código DGS
 * `N####` (#1741) — así que una columna llamada `isin` no podía guardar la
 * identidad de medio catálogo, y hoy ese código solo sobrevive de rebote dentro
 * del slug de finect. El peldaño hace tres cosas en una pasada: reconstruye la
 * tabla, copia lo que había y LEE lo que ya estaba escrito para tiparlo.
 *
 * Lee, nunca deriva (invariante 4 del PRD): lo que no case exacto por forma se
 * queda con `kind` null —un estado legal que salud de datos reclama— en vez de
 * inventar una identidad que después nadie revalida.
 */

import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { classifySecurityId } from "@worthline/domain";
import { describe, expect, test } from "vitest";

/** El esquema fresco con la tabla vieja: `isin` en el sitio del par. */
const LEGACY_SCHEMA_SQL = schemaSql.replace(
  "`security_id` text,\n\t`security_id_kind` text,",
  "`isin` text,",
);

interface SeedRow {
  id: string;
  isin?: string | null;
  priceProvider?: string | null;
  providerSymbol?: string | null;
}

async function seedV69(rows: readonly SeedRow[]): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(LEGACY_SCHEMA_SQL);
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (69)");

  for (const row of rows) {
    await client.execute({
      sql: `INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier)
            VALUES (?, ?, 'investment', 'EUR', 100000, 'market')`,
      args: [row.id, row.id],
    });
    await client.execute({
      sql: `INSERT INTO investment_assets
              (asset_id, unit_symbol, isin, price_provider, provider_symbol,
               manual_price_per_unit, benchmark_distributing)
            VALUES (?, 'uds', ?, ?, ?, '12.34', 1)`,
      args: [
        row.id,
        row.isin ?? null,
        row.priceProvider ?? null,
        row.providerSymbol ?? null,
      ],
    });
  }
  return client;
}

async function identityOf(
  client: Client,
  assetId: string,
): Promise<{ value: string | null; kind: string | null }> {
  const row = (
    await client.execute({
      sql: "SELECT security_id, security_id_kind FROM investment_assets WHERE asset_id = ?",
      args: [assetId],
    })
  ).rows[0]!;
  return {
    kind: row["security_id_kind"] === null ? null : String(row["security_id_kind"]),
    value: row["security_id"] === null ? null : String(row["security_id"]),
  };
}

async function columnNames(client: Client, table: string): Promise<string[]> {
  return (await client.execute(`PRAGMA table_info(${table})`)).rows.map((column) =>
    String(column["name"]),
  );
}

describe("schema migration v70 (el identificador tipado, #1743)", () => {
  test("la columna `isin` desaparece y nace el par", async () => {
    const client = await seedV69([{ id: "a_fund", isin: "IE00B03HCZ61" }]);

    await migrate(client);

    const columns = await columnNames(client, "investment_assets");
    expect(columns).toContain("security_id");
    expect(columns).toContain("security_id_kind");
    expect(columns).not.toContain("isin");
    expect(SCHEMA_VERSION).toBe(70);
  });

  test("un ISIN registrado queda tipado como lo que es", async () => {
    const client = await seedV69([{ id: "a_fund", isin: "IE00B03HCZ61" }]);

    await migrate(client);

    expect(await identityOf(client, "a_fund")).toEqual({
      kind: "isin",
      value: "IE00B03HCZ61",
    });
  });

  // El corazón del backfill: las dos filas reales de la cartera del padre.
  test("el código DGS sale del slug de finect y deja de vivir de rebote", async () => {
    const client = await seedV69([
      { id: "a_plan", priceProvider: "finect", providerSymbol: "N5394-Myinvestor" },
      {
        id: "a_plan_2",
        priceProvider: "finect",
        providerSymbol: "N5396-Myinvestor_indexado_global_pp",
      },
    ]);

    await migrate(client);

    expect(await identityOf(client, "a_plan")).toEqual({ kind: "dgs", value: "N5394" });
    expect(await identityOf(client, "a_plan_2")).toEqual({
      kind: "dgs",
      value: "N5396",
    });
  });

  test("el ISIN del slug de un fondo también se lee", async () => {
    const client = await seedV69([
      {
        id: "a_fondo",
        priceProvider: "finect",
        providerSymbol: "IE00BDZVHT63-Fidelity_SP500",
      },
    ]);

    await migrate(client);

    expect(await identityOf(client, "a_fondo")).toEqual({
      kind: "isin",
      value: "IE00BDZVHT63",
    });
  });

  test("lo que no case exacto por forma se queda sin clase, nunca inventada", async () => {
    const client = await seedV69([
      // Un slug que no empieza por identificador: no hay nada que leer.
      { id: "a_raro", priceProvider: "finect", providerSymbol: "fondo-raro-sin-codigo" },
      // Otro proveedor: su símbolo es una clave de cotización, no una identidad.
      { id: "a_yahoo", priceProvider: "yahoo", providerSymbol: "VUSA.L" },
      // Un valor legacy que el import de documento (#1416) dejó pasar tal cual:
      // se PRESERVA con la clase sin decidir, que es el estado que #1745 reclama.
      { id: "a_legacy", isin: "no-es-un-isin" },
    ]);

    await migrate(client);

    expect(await identityOf(client, "a_raro")).toEqual({ kind: null, value: null });
    expect(await identityOf(client, "a_yahoo")).toEqual({ kind: null, value: null });
    expect(await identityOf(client, "a_legacy")).toEqual({
      kind: null,
      value: "no-es-un-isin",
    });
  });

  test("el resto de la fila sobrevive al rebuild", async () => {
    const client = await seedV69([
      { id: "a_fund", isin: "IE00B03HCZ61", priceProvider: "yahoo", providerSymbol: "X" },
    ]);

    await migrate(client);

    const row = (
      await client.execute("SELECT * FROM investment_assets WHERE asset_id = 'a_fund'")
    ).rows[0]!;
    expect(row["unit_symbol"]).toBe("uds");
    expect(row["price_provider"]).toBe("yahoo");
    expect(row["provider_symbol"]).toBe("X");
    expect(row["manual_price_per_unit"]).toBe("12.34");
    expect(Number(row["benchmark_distributing"])).toBe(1);
  });

  test("la escalera y el esquema fresco convergen en la MISMA forma (ADR 0002)", async () => {
    const walked = await seedV69([{ id: "a_fund", isin: "IE00B03HCZ61" }]);
    await migrate(walked);

    const fresh = openLibsqlClient(":memory:");
    await fresh.executeMultiple(schemaSql);

    expect(await columnNames(walked, "investment_assets")).toEqual(
      await columnNames(fresh, "investment_assets"),
    );
  });

  test("el rebuild deja la clave foránea en pie: borrar el holding se lleva su fila", async () => {
    const client = await seedV69([{ id: "a_fund", isin: "IE00B03HCZ61" }]);
    await migrate(client);

    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("DELETE FROM assets WHERE id = 'a_fund'");

    const remaining = await client.execute(
      "SELECT COUNT(*) AS n FROM investment_assets WHERE asset_id = 'a_fund'",
    );
    expect(Number(remaining.rows[0]!["n"])).toBe(0);
  });

  test("volver a migrar no toca nada (el peldaño es idempotente)", async () => {
    const client = await seedV69([
      { id: "a_plan", priceProvider: "finect", providerSymbol: "N5394-Myinvestor" },
    ]);

    await migrate(client);
    await migrate(client);

    expect(await identityOf(client, "a_plan")).toEqual({ kind: "dgs", value: "N5394" });
  });

  /**
   * El guardián de la copia: `migrate.ts` es una hoja sin dependencia de
   * `@worthline/domain` (como `addMonthsClamped`), así que lleva su propia copia
   * del clasificador. Si las dos se separan, la migración escribe una identidad
   * que el resto de la aplicación no reconoce — y eso no se ve hasta producción.
   */
  test("el clasificador del peldaño dice lo mismo que el del dominio", async () => {
    const cases = [
      "IE00B03HCZ61",
      "ie00b03hcz61",
      "IE00B03HCZ62",
      "N5394",
      "n-5394",
      "F2244",
      "N539",
      "VUSA.L",
      "",
    ];
    const client = await seedV69(
      cases.map((value, index) => ({ id: `a_${index}`, isin: value || null })),
    );

    await migrate(client);

    for (const [index, value] of cases.entries()) {
      const stored = await identityOf(client, `a_${index}`);
      const expected = classifySecurityId(value);
      expect({ id: value, ...stored }).toEqual({
        id: value,
        kind: expected?.kind ?? null,
        value: expected?.value ?? (value || null),
      });
    }
  });
});
