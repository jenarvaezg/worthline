/**
 * The WORK a statement / mixed-document import actually does (#1440).
 *
 * #1435 batched the debt-balance chain. The extracto still wrote one operation
 * and one housing valuation per round-trip. The father's real file is 351
 * orders; each one is a Turso wait inside the one transaction.
 *
 * These tests pin the WRITE shape of `applyStatementImport`: the N creates and
 * M valuations go in as batched inserts, not N+M sequential round-trips. The
 * trail still gets one audit row per valuation.
 */

import type { WorthlineStore } from "@db/index";
import { createStoreFromSqlite, openLibsqlClient } from "@db/index";
import { describe, expect, test } from "vitest";

import { instrumentClient } from "./instrument-libsql-client";

const TODAY = "2026-06-12";
const OPERATION_COUNT = 24;
const VALUATION_COUNT = 12;

function addDays(from: string, count: number): string {
  const date = new Date(`${from}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

async function createCountingStore(): Promise<{
  store: WorthlineStore;
  operationInserts: () => number;
  valuationInserts: () => number;
  auditInserts: () => number;
  reset: () => void;
}> {
  let operations = 0;
  let valuations = 0;
  let audits = 0;
  const tally = (text: string): void => {
    if (!/^\s*insert/i.test(text)) return;
    if (/\basset_operations\b/i.test(text)) operations += 1;
    if (/\basset_valuations\b/i.test(text)) valuations += 1;
    if (/\baudit_log\b/i.test(text)) audits += 1;
  };
  const store = await createStoreFromSqlite(
    instrumentClient(openLibsqlClient(":memory:"), tally),
  );
  return {
    auditInserts: () => audits,
    operationInserts: () => operations,
    reset: () => {
      audits = 0;
      operations = 0;
      valuations = 0;
    },
    store,
    valuationInserts: () => valuations,
  };
}

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 200_000_00,
    id: "home",
    liquidityTier: "illiquid",
    name: "Vivienda",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "real_estate",
  });
}

function creates() {
  return Array.from({ length: OPERATION_COUNT }, (_, i) => ({
    assetId: "new_fund",
    currency: "EUR",
    executedAt: addDays("2024-01-10", i),
    feesMinor: 0,
    id: `op_${i}`,
    kind: "buy" as const,
    pricePerUnit: "50",
    units: "1",
  }));
}

function valuations() {
  return Array.from({ length: VALUATION_COUNT }, (_, i) => ({
    adjustsPriorCurve: true,
    assetId: "home",
    id: `home_appraisal_${i}`,
    source: "agent" as const,
    valuationDate: addDays("2024-02-01", i * 30),
    valueMinor: 200_000_00 + i * 1_000_00,
  }));
}

describe("statement import work shape (#1440)", () => {
  test("persists the orders and valuations in batched inserts", async () => {
    const { store, operationInserts, valuationInserts, auditInserts, reset } =
      await createCountingStore();
    await seed(store);

    reset();
    await store.command.applyStatementImport({
      funds: [
        {
          asset: {
            currency: "EUR",
            id: "new_fund",
            isin: "LU00WL000022",
            liquidityTier: "market",
            name: "Fondo nuevo",
            ownership: [{ memberId: "mJ", shareBps: 10_000 }],
            providerSymbol: "NUEVO.FAKE",
          },
          creates: creates(),
          kind: "new",
        },
      ],
      propertyValuations: valuations(),
      today: TODAY,
    });

    // ONE statement per table, not one round-trip per fact (the batches fit in
    // a single insert at this length).
    expect(operationInserts()).toBe(1);
    expect(valuationInserts()).toBe(1);
    expect(auditInserts()).toBe(1);
    expect(await store.operations.readOperations("new_fund")).toHaveLength(
      OPERATION_COUNT,
    );
    expect(await store.assets.readValuationAnchors("home")).toHaveLength(VALUATION_COUNT);
    const audit = await store.readAuditLog({ entityId: "home" });
    expect(audit.filter((entry) => entry.action === "add_valuation_anchor")).toHaveLength(
      VALUATION_COUNT,
    );

    store.close();
  });
});
