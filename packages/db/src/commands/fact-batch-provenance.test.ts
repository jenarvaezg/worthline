import { createStoreFromSqlite, openLibsqlClient } from "@worthline/db";
import { describe, expect, expectTypeOf, test } from "vitest";
import type { FactBatchInput } from "./types";

const TODAY = "2026-07-14";

describe("dated-fact command provenance (#889)", () => {
  test("does not accept dangling sync-run ids before #885 provides their table", () => {
    expectTypeOf<FactBatchInput>().not.toHaveProperty("syncRunId");
  });

  test("a manual investment operation is linked to its command's single batch", async () => {
    const client = openLibsqlClient(":memory:");
    const store = await createStoreFromSqlite(client);
    await store.workspace.initializeWorkspace({
      members: [{ id: "member", name: "Member" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      name: "Fund",
      ownership: [{ memberId: "member", shareBps: 10_000 }],
    });

    await store.command.recordInvestmentOperation(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2026-07-01",
        feesMinor: 0,
        id: "operation",
        kind: "buy",
        pricePerUnit: "100",
        units: "1",
      },
      { today: TODAY },
    );

    const batches = await client.execute("SELECT id, trigger FROM fact_batch");
    expect(batches.rows).toHaveLength(1);
    expect(batches.rows[0]!.trigger).toBe("manual");
    const facts = await client.execute(
      "SELECT batch_id FROM asset_operations WHERE id = 'operation'",
    );
    expect(facts.rows).toEqual([{ batch_id: batches.rows[0]!.id }]);
    store.close();
  });

  test("a manual operation merge links every create to one batch", async () => {
    const client = openLibsqlClient(":memory:");
    const store = await createStoreFromSqlite(client);
    await store.workspace.initializeWorkspace({
      members: [{ id: "member", name: "Member" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      name: "Fund",
      ownership: [{ memberId: "member", shareBps: 10_000 }],
    });

    await store.command.mergeInvestmentOperations({
      assetId: "fund",
      creates: ["first", "second"].map((id, index) => ({
        assetId: "fund",
        currency: "EUR" as const,
        executedAt: `2026-07-0${index + 1}`,
        feesMinor: 0,
        id,
        kind: "buy" as const,
        pricePerUnit: "100" as const,
        units: "1" as const,
      })),
      overwrites: [],
      today: TODAY,
    });

    const batches = await client.execute("SELECT id, trigger FROM fact_batch");
    expect(batches.rows).toHaveLength(1);
    expect(batches.rows[0]!.trigger).toBe("manual");
    const facts = await client.execute(
      "SELECT DISTINCT batch_id FROM asset_operations ORDER BY batch_id",
    );
    expect(facts.rows).toEqual([{ batch_id: batches.rows[0]!.id }]);
    store.close();
  });

  test("a statement batch links new facts without restamping overwritten operations", async () => {
    const client = openLibsqlClient(":memory:");
    const store = await createStoreFromSqlite(client);
    await store.workspace.initializeWorkspace({
      members: [{ id: "member", name: "Member" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      name: "Fund",
      ownership: [{ memberId: "member", shareBps: 10_000 }],
    });
    await store.command.recordInvestmentOperation(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2026-06-01",
        feesMinor: 0,
        id: "existing",
        kind: "buy",
        pricePerUnit: "100",
        units: "1",
      },
      { today: TODAY },
    );
    const initial = await client.execute(
      "SELECT batch_id FROM asset_operations WHERE id = 'existing'",
    );

    await store.command.applyStatementImport({
      funds: [
        {
          assetId: "fund",
          creates: [
            {
              assetId: "fund",
              currency: "EUR",
              executedAt: "2026-07-01",
              feesMinor: 0,
              id: "created",
              kind: "buy",
              pricePerUnit: "110",
              units: "1",
            },
          ],
          kind: "matched",
          overwrites: [
            {
              currency: "EUR",
              feesMinor: 0,
              id: "existing",
              kind: "buy",
              pricePerUnit: "105",
              units: "1",
            },
          ],
        },
      ],
      today: TODAY,
    });

    const batches = await client.execute(
      "SELECT id, trigger FROM fact_batch ORDER BY created_at, rowid",
    );
    expect(batches.rows).toHaveLength(2);
    expect(batches.rows[1]!.trigger).toBe("statement");
    const facts = await client.execute(
      "SELECT id, batch_id FROM asset_operations ORDER BY id",
    );
    expect(facts.rows).toEqual([
      { batch_id: batches.rows[1]!.id, id: "created" },
      { batch_id: initial.rows[0]!.batch_id, id: "existing" },
    ]);
    store.close();
  });

  test("an empty assistant statement application still records one assistant batch", async () => {
    const client = openLibsqlClient(":memory:");
    const store = await createStoreFromSqlite(client);
    const proposal = await store.assistantProposals.create({ kind: "statement_import" });

    await store.command.applyAssistantStatementProposal({
      funds: [],
      proposalId: proposal.id,
      today: TODAY,
    });

    const batches = await client.execute("SELECT trigger FROM fact_batch");
    expect(batches.rows).toEqual([{ trigger: "assistant" }]);
    expect(await store.assistantProposals.read(proposal.id)).toMatchObject({
      status: "applied",
    });
    store.close();
  });

  test("a manual valuation anchor is linked to its command's single batch", async () => {
    const client = openLibsqlClient(":memory:");
    const store = await createStoreFromSqlite(client);
    await store.workspace.initializeWorkspace({
      members: [{ id: "member", name: "Member" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "home",
      liquidityTier: "housing",
      name: "Home",
      ownership: [{ memberId: "member", shareBps: 10_000 }],
      type: "real_estate",
    });

    await store.command.addValuationAnchor(
      {
        adjustsPriorCurve: true,
        assetId: "home",
        id: "valuation",
        valuationDate: "2026-07-01",
        valueMinor: 200_000_00,
      },
      { today: TODAY },
    );

    const batches = await client.execute("SELECT id, trigger FROM fact_batch");
    expect(batches.rows).toHaveLength(1);
    expect(batches.rows[0]!.trigger).toBe("manual");
    const facts = await client.execute(
      "SELECT batch_id FROM asset_valuations WHERE id = 'valuation'",
    );
    expect(facts.rows).toEqual([{ batch_id: batches.rows[0]!.id }]);
    store.close();
  });

  test("housing valuation upsert links only the inserted anchor and never restamps it", async () => {
    const client = openLibsqlClient(":memory:");
    const store = await createStoreFromSqlite(client);
    await store.workspace.initializeWorkspace({
      members: [{ id: "member", name: "Member" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "home",
      liquidityTier: "housing",
      name: "Home",
      ownership: [{ memberId: "member", shareBps: 10_000 }],
      type: "real_estate",
    });

    await store.command.recordHousingValuation("home", 210_000_00, { today: TODAY });
    const inserted = await client.execute(
      `SELECT batch_id FROM asset_valuations
       WHERE asset_id = 'home' AND valuation_date = '${TODAY}'`,
    );
    await store.command.recordHousingValuation("home", 220_000_00, { today: TODAY });

    const batches = await client.execute("SELECT id, trigger FROM fact_batch");
    expect(batches.rows).toHaveLength(2);
    expect(batches.rows.every((row) => row.trigger === "manual")).toBe(true);
    const updated = await client.execute(
      `SELECT batch_id, value_minor FROM asset_valuations
       WHERE asset_id = 'home' AND valuation_date = '${TODAY}'`,
    );
    expect(updated.rows).toEqual([
      { batch_id: inserted.rows[0]!.batch_id, value_minor: 220_000_00 },
    ]);
    store.close();
  });

  test("a manual debt balance anchor is linked to its command's single batch", async () => {
    const client = openLibsqlClient(":memory:");
    const store = await createStoreFromSqlite(client);
    await store.workspace.initializeWorkspace({
      members: [{ id: "member", name: "Member" }],
      mode: "individual",
    });
    await store.liabilities.createLiability({
      balanceMinor: 10_000,
      currency: "EUR",
      id: "debt",
      name: "Debt",
      ownership: [{ memberId: "member", shareBps: 10_000 }],
      type: "mortgage",
    });
    await store.liabilities.setDebtModel("debt", "informal");

    await store.command.addBalanceAnchor(
      {
        anchorDate: "2026-07-01",
        balanceMinor: 10_000,
        id: "anchor",
        liabilityId: "debt",
      },
      { today: TODAY },
    );

    const batches = await client.execute("SELECT id, trigger FROM fact_batch");
    expect(batches.rows).toHaveLength(1);
    expect(batches.rows[0]!.trigger).toBe("manual");
    const facts = await client.execute(
      "SELECT batch_id FROM liability_balance_anchors WHERE id = 'anchor'",
    );
    expect(facts.rows).toEqual([{ batch_id: batches.rows[0]!.id }]);
    store.close();
  });

  test("a manual balance rebaseline is linked to its command's single batch", async () => {
    const client = openLibsqlClient(":memory:");
    const store = await createStoreFromSqlite(client);
    await store.workspace.initializeWorkspace({
      members: [{ id: "member", name: "Member" }],
      mode: "individual",
    });
    await store.liabilities.createLiability({
      balanceMinor: 100_000,
      currency: "EUR",
      id: "mortgage",
      name: "Mortgage",
      ownership: [{ memberId: "member", shareBps: 10_000 }],
      type: "mortgage",
    });
    await store.liabilities.setDebtModel("mortgage", "amortizable");

    await store.command.addBalanceRebaseline(
      {
        annualInterestRate: "0.03",
        baselineDate: "2026-07-01",
        endDate: "2036-07-01",
        id: "rebaseline",
        liabilityId: "mortgage",
        nextPaymentDate: "2026-08-01",
        outstandingBalanceMinor: 100_000,
      },
      { today: TODAY },
    );

    const batches = await client.execute("SELECT id, trigger FROM fact_batch");
    expect(batches.rows).toHaveLength(1);
    expect(batches.rows[0]!.trigger).toBe("manual");
    const facts = await client.execute(
      "SELECT batch_id FROM liability_balance_rebaselines WHERE id = 'rebaseline'",
    );
    expect(facts.rows).toEqual([{ batch_id: batches.rows[0]!.id }]);
    store.close();
  });
});
