/**
 * Schema migration v72 (#1812): la edad objetivo de 65 que el parser escribía antes
 * de #1474 sale de la config guardada.
 *
 * Hasta #1474, `parseFireConfigFormStrict` guardaba `targetRetirementAge: ?? 65` en
 * cada config, y el formulario precargaba ese 65. No queda rastro de quién lo puso:
 * `fire.config` es un JSON por ámbito sin procedencia por campo, y el `updated_at` es
 * de la fila entera. Un 65 tecleado y uno rellenado son el mismo `65`. Leído como
 * declaración, ese 65 rompía la condición de una pensión («supone cotizar hasta
 * 2033-05») con un «declaraste jubilarte a los 65» que el usuario nunca escribió,
 * justo lo que ADR 0111 §6 promete no hacer.
 *
 * El peldaño quita el 65 y nada más. El motor sigue calculando con su `?? 65`, así que
 * ninguna cifra cambia: lo único que se pierde es una declaración que no se puede
 * probar, y se recupera tecleándola. Cualquier otra edad la tecleó el usuario, porque
 * el parser viejo solo rellenaba 65.
 */

import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { createStoreFromSqlite } from "@db/testing";
import type { Client } from "@libsql/client";
import {
  calculateFireForScope,
  type FireScopeConfig,
  fireSustainableSpending,
  fixedClock,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";

const TODAY = "2026-10-12";
const clock = fixedClock(`${TODAY}T09:00:00.000Z`);

/** Lo que guardaba el formulario antes de #1474 sin tocar el campo de la edad. */
const PRE_1474_CONFIG: FireScopeConfig = {
  monthlySpendingMinor: 2_000_00,
  safeWithdrawalRate: 0.04,
  targetRetirementAge: 65,
};

async function storedFireConfig(
  client: Client,
): Promise<Record<string, FireScopeConfig> | undefined> {
  const row = await client.execute(
    "SELECT value FROM app_settings WHERE key = 'fire.config'",
  );
  return row.rows[0] === undefined
    ? undefined
    : (JSON.parse(String(row.rows[0].value)) as Record<string, FireScopeConfig>);
}

/** Un cliente crudo en v71 con la tabla de ajustes y, si se da, una `fire.config`. */
async function seedV71(config?: Record<string, FireScopeConfig>): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(`
    CREATE TABLE schema_meta (version INTEGER NOT NULL);
    INSERT INTO schema_meta (version) VALUES (71);
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    INSERT INTO app_settings (key, value) VALUES ('display.locale', '"es-ES"');
  `);
  if (config) {
    await client.execute({
      args: [JSON.stringify(config)],
      sql: "INSERT INTO app_settings (key, value) VALUES ('fire.config', ?)",
    });
  }
  return client;
}

describe("schema migration v72 (el 65 fantasma de la edad objetivo)", () => {
  test("pins the current schema version", () => {
    expect(SCHEMA_VERSION).toBe(73);
  });

  test("quita el 65 de cada ámbito y conserva intacto todo lo demás", async () => {
    const client = await seedV71({
      group_couple: { ...PRE_1474_CONFIG, targetRetirementAge: 60 },
      household: {
        ...PRE_1474_CONFIG,
        capitalLastsUntilAge: 90,
        retirementPlan: "ordinary",
      },
      member_only: { monthlySpendingMinor: 1_500_00, safeWithdrawalRate: 0.035 },
    });
    try {
      await migrate(client);

      expect(await storedFireConfig(client)).toEqual({
        // Otra edad la tecleó alguien: el parser viejo solo rellenaba 65.
        group_couple: { ...PRE_1474_CONFIG, targetRetirementAge: 60 },
        household: {
          capitalLastsUntilAge: 90,
          monthlySpendingMinor: 2_000_00,
          retirementPlan: "ordinary",
          safeWithdrawalRate: 0.04,
        },
        member_only: { monthlySpendingMinor: 1_500_00, safeWithdrawalRate: 0.035 },
      });
      expect(
        (
          await client.execute(
            "SELECT value FROM app_settings WHERE key = 'display.locale'",
          )
        ).rows[0]?.value,
      ).toBe('"es-ES"');
    } finally {
      client.close();
    }
  });

  test("sin `fire.config` no escribe nada, y sin tabla de ajustes no falla", async () => {
    const withoutConfig = await seedV71();
    try {
      await migrate(withoutConfig);
      expect(await storedFireConfig(withoutConfig)).toBeUndefined();
    } finally {
      withoutConfig.close();
    }

    const bare = openLibsqlClient(":memory:");
    try {
      await bare.executeMultiple(`
        CREATE TABLE schema_meta (version INTEGER NOT NULL);
        INSERT INTO schema_meta (version) VALUES (71);
      `);
      await migrate(bare);
      expect(
        (await bare.execute("SELECT version FROM schema_meta")).rows[0]?.version,
      ).toBe(SCHEMA_VERSION);
    } finally {
      bare.close();
    }
  });

  test("una config anterior a #1474 deja la pensión sin contrastar, no rota", async () => {
    // El escenario del issue: nacimiento en 1966-05, una pensión que supone cotizar
    // hasta 2033-05 y el 65 que nadie declaró. 1966 + 65 = 2031, antes de la condición.
    const client = openLibsqlClient(":memory:");
    try {
      const store = await createStoreFromSqlite(client, { clock });
      await store.workspace.initializeWorkspace({
        members: [{ birthMonth: 5, birthYear: 1966, id: "m_owner", name: "Titular" }],
        mode: "individual",
      });
      await store.payouts.createPayoutSchedule({
        amountBasis: "real",
        amountMinor: 1_800_00,
        assumedContributionThrough: "2033-05-31",
        cadence: "monthly",
        label: "Pensión de jubilación",
        nature: "passive",
        provenance: "official_simulation",
        provenanceAsOf: "2026-09-01",
        startISO: "2033-06-01",
      });
      await store.saveFireConfig("household", PRE_1474_CONFIG);

      const sustainable = async (opened: typeof store) => {
        const config = (await opened.readFireConfig(TODAY)).household!;
        const fire = calculateFireForScope(
          config,
          await opened.assets.readAssets(),
          [],
          (await opened.workspace.readWorkspace())!,
          "household",
          0,
          {
            rents: {
              schedules: await opened.payouts.readPayoutSchedules(),
              todayISO: TODAY,
            },
          },
        );
        return { config, fire, spending: fireSustainableSpending(fire)! };
      };

      // El fallo, tal cual: leído como declaración, el 65 saca la pensión de la tarjeta.
      const before = await sustainable(store);
      expect(
        before.spending.incomes.conditionBroken.map((line) => line.retirement),
      ).toEqual([{ age: 65, month: 5, year: 2031 }]);

      await client.execute("UPDATE schema_meta SET version = 71");
      const after = await sustainable(await createStoreFromSqlite(client, { clock }));

      expect(after.config.targetRetirementAge).toBeUndefined();
      expect(after.spending.incomes.conditionBroken).toEqual([]);
      expect(after.spending.incomes.upcoming.map((line) => line.condition)).toEqual([
        { missing: "retirement_age", state: "unchecked", throughISO: "2033-05-31" },
      ]);
      // El motor sigue calculando con su `?? 65`: quitar el fantasma no mueve ninguna
      // cifra, ni siquiera el coast, la única que cuenta los años hasta la jubilación.
      expect(before.fire.coastFireRequired).toBeDefined();
      expect(after.fire.coastFireRequired).toEqual(before.fire.coastFireRequired);
      expect(after.spending.perpetual).toEqual(before.spending.perpetual);
    } finally {
      client.close();
    }
  });
});
