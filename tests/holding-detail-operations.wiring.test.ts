/**
 * Wiring suite: the holding detail's `derived` operations surface (PRD #146, S6,
 * #152).
 *
 * The unified detail page `/patrimonio/[id]/editar` binds the SAME operations
 * actions /inversiones uses (recordOperationAction / deleteOperationAction) with
 * a `/patrimonio/[id]/editar` currentUrl. This suite proves the full surface loop
 * from that context — buy → derived units/value, sell → reduced units, delete →
 * reverted — and that the detail page reads the investment as a holding with its
 * derived value (ADR 0006). Real in-memory store, next/cache stubbed.
 */

import { vi, describe, test, expect, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { valuationMethodOfAsset } from "@worthline/domain";
import { deleteOperationAction, recordOperationAction } from "@web/inversiones/actions";
import { catchRedirect, fd } from "./helpers";

const MEMBER_ID = "member_yo";
const ASSET_ID = "asset_fund_s6";
const DETAIL_URL = `/patrimonio/${ASSET_ID}/editar`;

let store: WorthlineStore;

afterEach(() => {
  store?.close();
});

function setupInvestment(): WorthlineStore {
  store = createInMemoryStore();
  store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Yo" }],
    mode: "individual",
  });
  store.assets.createInvestmentAsset({
    id: ASSET_ID,
    name: "Fondo Ficha",
    currency: "EUR",
    liquidityTier: "market",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    manualPricePerUnit: "100",
  });
  return store;
}

function positionUnits(): string | undefined {
  return store.snapshots.readPositions().find((p) => p.assetId === ASSET_ID)
    ?.currentUnits;
}

describe("holding detail — derived dispatch (#152)", () => {
  test("an investment read off readAssets dispatches to the derived surface", () => {
    setupInvestment();
    const asset = store.assets.readAssets().find((a) => a.id === ASSET_ID)!;

    expect(asset).toBeDefined();
    expect(valuationMethodOfAsset(asset)).toBe("derived");
    // ADR 0006: value is derived, present on the holding even with a manual price.
    expect(asset.currentValue.amountMinor).toBeGreaterThanOrEqual(0);
  });
});

describe("holding detail — operations surface loop from /patrimonio (#152)", () => {
  test("record buy from the detail page persists and returns to the detail url", async () => {
    setupInvestment();

    const url = await catchRedirect(() =>
      recordOperationAction(
        ASSET_ID,
        fd(
          {
            kind: "buy",
            units: "10",
            pricePerUnit: "100",
            fees: "0",
            executedAt: "2024-01-10",
          },
          DETAIL_URL,
        ),
        store,
      ),
    );

    expect(url).toContain(DETAIL_URL);
    expect(url).toContain("ok=saved");
    expect(store.operations.readOperations(ASSET_ID)).toHaveLength(1);
    expect(positionUnits()).toBe("10");
  });

  test("record sell reduces the derived units", async () => {
    setupInvestment();

    await catchRedirect(() =>
      recordOperationAction(
        ASSET_ID,
        fd(
          {
            kind: "buy",
            units: "10",
            pricePerUnit: "100",
            fees: "0",
            executedAt: "2024-01-10",
          },
          DETAIL_URL,
        ),
        store,
      ),
    );

    const url = await catchRedirect(() =>
      recordOperationAction(
        ASSET_ID,
        fd(
          {
            kind: "sell",
            units: "4",
            pricePerUnit: "120",
            fees: "0",
            executedAt: "2024-02-10",
          },
          DETAIL_URL,
        ),
        store,
      ),
    );

    expect(url).toContain(DETAIL_URL);
    expect(store.operations.readOperations(ASSET_ID)).toHaveLength(2);
    expect(positionUnits()).toBe("6");
  });

  test("delete an operation from the detail page reverts the units", async () => {
    setupInvestment();

    await catchRedirect(() =>
      recordOperationAction(
        ASSET_ID,
        fd(
          {
            kind: "buy",
            units: "10",
            pricePerUnit: "100",
            fees: "0",
            executedAt: "2024-01-10",
          },
          DETAIL_URL,
        ),
        store,
      ),
    );
    await catchRedirect(() =>
      recordOperationAction(
        ASSET_ID,
        fd(
          {
            kind: "sell",
            units: "4",
            pricePerUnit: "120",
            fees: "0",
            executedAt: "2024-02-10",
          },
          DETAIL_URL,
        ),
        store,
      ),
    );

    const sellOp = store.operations
      .readOperations(ASSET_ID)
      .find((op) => op.kind === "sell")!;

    const url = await catchRedirect(() =>
      deleteOperationAction(ASSET_ID, fd({ operationId: sellOp.id }, DETAIL_URL), store),
    );

    expect(url).toContain(DETAIL_URL);
    expect(url).toContain("ok=operation_deleted");
    expect(store.operations.readOperations(ASSET_ID)).toHaveLength(1);
    expect(positionUnits()).toBe("10");
  });
});
