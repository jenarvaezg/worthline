/**
 * What the pages compose does not write (#1842, PRD #1718).
 *
 * A viewer's store refuses every statement that is not a read. The six read
 * models the workspace pages are built from must therefore run end to end over
 * a read-only store: a seeded book (the familia persona, plus a managed
 * portfolio, a captured history and two incomes) is closed and reopened with
 * `readOnly: true`, and each loader runs against it. A loader that wrote on
 * render would surface here as a `ReadOnlyWorkspaceError`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seedPersona } from "@web/demo/seed-persona";
import { FAMILIA_SPEC } from "@web/demo/specs/familia";
import { loadDashboard } from "@web/load-dashboard";
import { loadObjetivos } from "@web/objetivos/load-objetivos";
import { loadRentas } from "@web/objetivos/rentas/load-rentas";
import { portfolioWitnessView } from "@web/patrimonio/carteras/carteras-view";
import { loadCarteras } from "@web/patrimonio/carteras/load-carteras";
import { loadPortfolioReturns } from "@web/patrimonio/carteras/load-portfolio-returns";
import { loadPatrimonio } from "@web/patrimonio/load-patrimonio";
import { captureDailySnapshotForWorkspace, type WorthlineStore } from "@worthline/db";
import { createWorthlineStoreUnsafe } from "@worthline/db/unsafe-store";
import { listScopeOptions, type Workspace } from "@worthline/domain";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const AS_OF = "2026-06-19";
const NOW_ISO = `${AS_OF}T12:00:00.000Z`;
const SEED_TIMEOUT_MS = 30_000;

const persistence = {
  status: "ok" as const,
  checkKey: "bootstrap.last_healthcheck_at",
  checkedAt: NOW_ISO,
  checkValue: NOW_ISO,
  databasePath: "/tmp/worthline-viewer.sqlite",
  displayPath: "viewer.sqlite",
};

let dir: string;
let databasePath: string;
let viewer: WorthlineStore;
let workspace: Workspace;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worthline-viewer-loaders-"));
  databasePath = join(dir, "workspace.sqlite");

  const owner = await createWorthlineStoreUnsafe({ databasePath });
  try {
    await seedPersona(owner, FAMILIA_SPEC, AS_OF);
    await owner.managedPortfolios.createManagedPortfolio({
      containerOwnership: [{ memberId: "member_marta", shareBps: 10_000 }],
      memberHoldingIds: ["asset_familia_etf"],
      name: "Cartera gestionada",
      scopeId: "household",
    });
    await owner.payouts.createPayoutSchedule({
      amountMinor: 90_000,
      cadence: "monthly",
      holdingId: "asset_familia_home",
      label: "Alquiler",
      startISO: "2024-01-01",
    });
    await owner.payouts.createPayoutSchedule({
      amountMinor: 150_000,
      cadence: "monthly",
      label: "Pensión pública",
      startISO: "2040-11-01",
    });
    await captureDailySnapshotForWorkspace(owner, NOW_ISO);
  } finally {
    owner.close();
  }

  viewer = await createWorthlineStoreUnsafe({ databasePath, readOnly: true });
  const read = await viewer.workspace.readWorkspace();
  if (!read) throw new Error("seeded workspace missing");
  workspace = read;
}, SEED_TIMEOUT_MS);

afterAll(() => {
  viewer?.close();
  rmSync(dir, { force: true, recursive: true });
});

describe("the page read models run over a read-only store", () => {
  test("loadDashboard", async () => {
    const result = await loadDashboard({
      store: viewer,
      persistence,
      scopeId: undefined,
      selectedView: "total",
      today: AS_OF,
      now: NOW_ISO,
    });
    expect(result.needsOnboarding).toBe(false);
  });

  test("loadPatrimonio", async () => {
    const scopes = listScopeOptions(workspace);
    const result = await loadPatrimonio({
      store: viewer,
      workspace,
      selectedScope: scopes[0],
      today: AS_OF,
      selectedGroup: "direction",
    });
    expect(result.hasHoldings).toBe(true);
  });

  test("loadObjetivos", async () => {
    const scopes = listScopeOptions(workspace);
    const result = await loadObjetivos({
      store: viewer,
      workspace,
      scopes,
      selectedScope: scopes[0],
      persistence,
      today: AS_OF,
    });
    expect(result.assets.length).toBeGreaterThan(0);
  });

  test("loadRentas", async () => {
    const result = await loadRentas({
      scopeId: "household",
      store: viewer,
      today: AS_OF,
      workspace,
    });
    expect(result.incomes.map((income) => income.label).sort()).toEqual([
      "Alquiler",
      "Pensión pública",
    ]);
  });

  test("loadCarteras and loadPortfolioReturns", async () => {
    const model = await loadCarteras({
      baseCurrency: workspace.baseCurrency,
      scopeId: undefined,
      store: viewer,
      today: AS_OF,
    });
    const portfolio = model.allPortfolios.find(
      (candidate) => candidate.name === "Cartera gestionada",
    );
    expect(portfolio).toBeDefined();
    if (!portfolio) return;

    const witness = portfolioWitnessView({
      baseCurrency: workspace.baseCurrency,
      moneyByHoldingId: model.moneyByHoldingId,
      portfolio,
      typeByHoldingId: model.typeByHoldingId,
    });
    const returns = await loadPortfolioReturns({
      baseCurrency: workspace.baseCurrency,
      model,
      portfolio,
      store: viewer,
      today: AS_OF,
      witness,
    });
    // The ETF carries a ledger, so there is a return to measure.
    expect(returns).not.toBeNull();
  });
});
