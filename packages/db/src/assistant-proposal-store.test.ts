import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ParsedStatementRow } from "@worthline/domain";
import { describe, expect, it } from "vitest";

import { createInMemoryStore, createWorthlineStore } from "./index";

const row: ParsedStatementRow = {
  currency: "EUR",
  dateKey: "2026-06-15",
  feesMinor: 125,
  isin: "ES0123456789",
  kind: "buy",
  pricePerUnit: "12.5",
  units: "8",
};

describe("assistant proposal store", () => {
  it("round-trips typed debt observations without raw document contents", async () => {
    const store = await createInMemoryStore();
    const proposal = await store.assistantProposals.create({
      kind: "balance_history_import",
    });
    await store.assistantProposals.appendDocument(proposal.id, {
      document: { name: "cuadro.pdf", provenance: "agent", sha256: "d".repeat(64) },
      facts: [
        {
          kind: "debt_balance_observation",
          row: { balanceMinor: 140_000_00, date: "2026-06-15", liabilityId: "mortgage" },
        },
      ],
    });
    const stored = await store.assistantProposals.read(proposal.id);
    expect(stored).toMatchObject({
      kind: "balance_history_import",
      documents: [{ facts: [{ kind: "debt_balance_observation" }] }],
    });
    expect(JSON.stringify(stored)).not.toContain("rawText");
    store.close();
  });
  it("accumulates parsed facts and document references in one persisted draft", async () => {
    const store = await createInMemoryStore();
    const proposal = await store.assistantProposals.create({ kind: "statement_import" });

    await store.assistantProposals.appendDocument(proposal.id, {
      document: {
        name: "enero.csv",
        provenance: "agent",
        sha256: "a".repeat(64),
      },
      facts: [row],
    });
    await store.assistantProposals.appendDocument(proposal.id, {
      document: {
        name: "febrero.csv",
        provenance: "user",
        sha256: "b".repeat(64),
      },
      facts: [{ kind: "statement_operation", row: { ...row, dateKey: "2026-07-01" } }],
    });

    expect(await store.assistantProposals.read(proposal.id)).toMatchObject({
      id: proposal.id,
      kind: "statement_import",
      status: "draft",
      documents: [
        {
          document: {
            name: "enero.csv",
            provenance: "agent",
            sha256: "a".repeat(64),
          },
          facts: [{ kind: "statement_operation", row }],
        },
        {
          document: {
            name: "febrero.csv",
            provenance: "user",
            sha256: "b".repeat(64),
          },
          facts: [
            { kind: "statement_operation", row: { ...row, dateKey: "2026-07-01" } },
          ],
        },
      ],
    });

    store.close();
  });

  it.each([
    "applied",
    "discarded",
  ] as const)("makes %s a terminal status that rejects appends and double resolution", async (terminal) => {
    const store = await createInMemoryStore();
    const proposal = await store.assistantProposals.create({ kind: "statement_import" });
    const resolve =
      terminal === "applied"
        ? store.assistantProposals.markApplied
        : store.assistantProposals.markDiscarded;

    const resolved = await resolve(proposal.id);
    expect(resolved.status).toBe(terminal);
    await expect(resolve(proposal.id)).rejects.toThrow(/already resolved/i);
    await expect(
      store.assistantProposals.appendDocument(proposal.id, {
        document: {
          name: "late.csv",
          provenance: "agent",
          sha256: "c".repeat(64),
        },
        facts: [row],
      }),
    ).rejects.toThrow(/already resolved/i);

    store.close();
  });

  it("returns null for an unknown proposal and rejects malformed SHA-256 hashes", async () => {
    const store = await createInMemoryStore();
    expect(await store.assistantProposals.read("missing")).toBeNull();
    const proposal = await store.assistantProposals.create({ kind: "statement_import" });
    await expect(
      store.assistantProposals.appendDocument(proposal.id, {
        document: {
          name: "statement.csv",
          provenance: "agent",
          sha256: "not-a-hash",
        },
        facts: [row],
      }),
    ).rejects.toThrow(/SHA-256/);
    store.close();
  });

  it("allowlists typed command fields before serializing proposed facts", async () => {
    const store = await createInMemoryStore();
    const proposal = await store.assistantProposals.create({ kind: "statement_import" });
    await store.assistantProposals.appendDocument(proposal.id, {
      document: {
        name: "safe.csv",
        provenance: "agent",
        sha256: "f".repeat(64),
      },
      facts: [{ ...row, rawText: "documento crudo" } as ParsedStatementRow],
    });

    expect(
      JSON.stringify(await store.assistantProposals.read(proposal.id)),
    ).not.toContain("documento crudo");
    store.close();
  });

  it("survives closing and reopening the database", async () => {
    const databasePath = join(
      mkdtempSync(join(tmpdir(), "wl-proposal-")),
      "worthline.db",
    );
    const store = await createWorthlineStore({ databasePath });
    const proposal = await store.assistantProposals.create({ kind: "statement_import" });
    await store.assistantProposals.appendDocument(proposal.id, {
      document: {
        name: "persisted.csv",
        provenance: "agent",
        sha256: "d".repeat(64),
      },
      facts: [row],
    });
    store.close();

    const reopened = await createWorthlineStore({ databasePath });
    expect(await reopened.assistantProposals.read(proposal.id)).toMatchObject({
      documents: [{ document: { name: "persisted.csv" }, facts: [{ row }] }],
      status: "draft",
    });
    reopened.close();
  });

  it("resolves the proposal and applies its statement in one transaction", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "m1", name: "Uno" }],
      mode: "individual",
    });
    const proposal = await store.assistantProposals.create({ kind: "statement_import" });
    await store.assistantProposals.appendDocument(proposal.id, {
      document: {
        name: "statement.csv",
        provenance: "agent",
        sha256: "e".repeat(64),
      },
      facts: [row],
    });

    await store.command.applyAssistantStatementProposal({
      funds: [
        {
          asset: {
            currency: "EUR",
            id: "fund_atomic",
            ...(row.isin ? { isin: row.isin } : {}),
            liquidityTier: "market",
            name: "Fondo atómico",
            ownership: [{ memberId: "m1", shareBps: 10_000 }],
          },
          creates: [
            {
              assetId: "fund_atomic",
              currency: row.currency,
              executedAt: row.dateKey,
              feesMinor: row.feesMinor,
              id: "op_atomic",
              kind: row.kind,
              pricePerUnit: row.pricePerUnit,
              source: "agent",
              units: row.units,
            },
          ],
          kind: "new",
        },
      ],
      proposalId: proposal.id,
      today: "2026-07-12",
    });

    expect(await store.assistantProposals.read(proposal.id)).toMatchObject({
      status: "applied",
    });
    expect(await store.assets.readInvestmentAssetById("fund_atomic")).not.toBeNull();
    store.close();
  });
});
