/**
 * «Coste del traspaso» (#1882): whether the panel's FORM reaches the command intact
 * — the cost as typed in es-ES, «Sí, vienen de ahí» on the proposed reimbursement,
 * and every refusal back as state beside the field. What an answer IS (one batch,
 * one ripple, the cost that travels) is the command's suite:
 * `packages/db/src/commands/inherited-cost.test.ts`.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import type { CreateInvestmentOperationInput } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { resolveInheritedCostAction } from "./inherited-cost-action";

const TODAY = "2026-11-04";
const FICHA = "/patrimonio/wl_hld_x/editar?pestaña=operaciones";
const OWNER = [{ memberId: "m", shareBps: 10_000 }];

function op(
  overrides: Partial<CreateInvestmentOperationInput> & { id: string; assetId: string },
): CreateInvestmentOperationInput {
  return {
    currency: "EUR",
    executedAt: "2026-06-11",
    feesMinor: 0,
    kind: "buy",
    pricePerUnit: "23.17",
    source: "connected",
    units: "37",
    ...overrides,
  };
}

const operations: CreateInvestmentOperationInput[] = [
  op({ assetId: "origen", executedAt: "2025-03-04", id: "compra" }),
  op({
    assetId: "origen",
    id: "reembolso",
    kind: "sell",
    pricePerUnit: "26.41",
    transferLegState: "unpaired_out",
  }),
  op({
    assetId: "destino",
    executedAt: "2026-06-16",
    id: "suscripcion",
    kind: "transfer_in",
    pricePerUnit: "23.5116",
    transferCostMinor: 97_103,
    transferId: "myinvestor-unpaired:r-in",
    transferLegState: "cost_pending",
    units: "41.3",
  }),
];

async function seed(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Titular" }],
    mode: "individual",
  });
  const connected = await store.connectedSources.connectOwningSource({
    adapter: "myinvestor",
    credentialsJson: "{}",
    label: "MyInvestor",
  });
  await store.command.includeConnectedHoldings({
    facts: {
      cursor: TODAY,
      facts: operations.map((operation) => ({
        dateKey: operation.executedAt,
        key: operation.id,
        payload: operation,
      })),
    },
    holdings: ["origen", "destino"].map((id) => ({
      holding: {
        asset: {
          currency: "EUR",
          id,
          instrument: "fund" as const,
          liquidityTier: "market" as const,
          name: id,
          ownership: OWNER,
        },
        kind: "investment" as const,
      },
      productKey: `p-${id}`,
    })),
    sourceId: connected!.sourceId,
    today: TODAY,
  });
  return store;
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("currentUrl", FICHA);
  fd.set("entryId", "suscripcion");
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function redirectOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") return e.digest;
    throw err;
  }
}

async function entry(store: WorthlineStore) {
  return (await store.operations.readOperations("destino")).find(
    (operation) => operation.id === "suscripcion",
  );
}

describe("resolveInheritedCostAction", () => {
  test("the typed cost, in es-ES, lands as the declared cost", async () => {
    const store = await seed();

    const url = await redirectOf(
      resolveInheritedCostAction(
        "destino",
        form({ inheritedCost: "903,17", mode: "declared" }),
        store,
      ),
    );

    expect(url).toContain("ok=inherited_cost_declared");
    expect(await entry(store)).toMatchObject({
      transferCostMinor: 90_317,
      transferLegState: "cost_declared",
    });
  });

  test("«Sí, vienen de ahí» pairs the reimbursement and says so", async () => {
    const store = await seed();

    const url = await redirectOf(
      resolveInheritedCostAction(
        "destino",
        form({ mode: "origin", originId: "reembolso" }),
        store,
      ),
    );

    expect(url).toContain("ok=inherited_cost_from_origin");
    expect(await entry(store)).toMatchObject({
      transferCostMinor: 85_729,
      transferLegState: "cost_from_origin",
    });
  });

  test("a cost that is not a figure comes back as state, with what was typed", async () => {
    const store = await seed();

    const state = await resolveInheritedCostAction(
      "destino",
      form({ inheritedCost: "mucho", inlineError: "1", mode: "declared" }),
      store,
    );

    expect(state).toEqual({
      error: "Escribe el coste en euros, por ejemplo 6.200,00.",
      ok: false,
      values: { inheritedCost: "mucho" },
    });
    expect(await entry(store)).toMatchObject({ transferLegState: "cost_pending" });
  });

  test("an origin the rule would not propose is refused beside the field", async () => {
    const store = await seed();

    const state = await resolveInheritedCostAction(
      "destino",
      form({ inlineError: "1", mode: "origin", originId: "compra" }),
      store,
    );

    expect(state).toMatchObject({ ok: false });
    expect(state.ok ? null : state.error).toContain("ya no puede ser el origen");
  });
});
