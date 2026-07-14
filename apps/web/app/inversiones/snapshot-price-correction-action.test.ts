/**
 * Single-date snapshot price correction actions (#926).
 *
 * Preview shows counts and writes NOTHING; confirm applies and redirects.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  confirmSnapshotPriceCorrectionAction,
  previewSnapshotPriceCorrectionAction,
} from "./actions";

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "gold",
    liquidityTier: "market",
    name: "Oro físico",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    priceProvider: "yahoo",
    providerSymbol: "GBSE.MI",
  });
  await store.command.recordInvestmentOperation(
    {
      assetId: "gold",
      currency: "EUR",
      executedAt: "2026-07-09",
      feesMinor: 0,
      id: "op_jul",
      kind: "buy",
      pricePerUnit: "10",
      units: "3",
    },
    { today: "2026-07-15" },
  );
}

function correctionForm(dateKey = "2026-07-09", unitPrice = "12.5"): FormData {
  const fd = new FormData();
  fd.set("currentUrl", "/patrimonio/gold/editar");
  fd.set("dateKey", dateKey);
  fd.set("unitPrice", unitPrice);
  return fd;
}

describe("previewSnapshotPriceCorrectionAction (#926)", () => {
  test("returns summary and writes NOTHING", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const state = await previewSnapshotPriceCorrectionAction(
      "gold",
      { status: "idle" },
      correctionForm(),
      store,
    );

    expect(state).toEqual({
      create: 0,
      dateKey: "2026-07-09",
      status: "summary",
      unitPrice: "12.5",
      units: "3",
      update: 1,
      valueMinor: 3750,
    });

    const row = (
      await store.snapshots.readSnapshotHoldings({ holdingId: "gold", kind: "asset" })
    ).find((r) => r.dateKey === "2026-07-09");
    expect(row?.unitPrice).toBeUndefined();
    store.close();
  });

  test("surfaces validation errors", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const state = await previewSnapshotPriceCorrectionAction(
      "gold",
      { status: "idle" },
      correctionForm("2026-06-01", "12.5"),
      store,
    );

    expect(state).toEqual({
      message: "No había posición abierta en esa fecha.",
      status: "error",
    });
    store.close();
  });

  test("rejects a future date server-side even though the form input caps at today", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const clock = {
      now: () => "2026-07-15T10:00:00.000Z",
      today: () => "2026-07-15",
    };

    const state = await previewSnapshotPriceCorrectionAction(
      "gold",
      { status: "idle" },
      correctionForm("2026-07-20", "12.5"),
      store,
      clock,
    );

    expect(state).toEqual({
      message: "La fecha no puede ser futura.",
      status: "error",
    });
    store.close();
  });
});

describe("confirmSnapshotPriceCorrectionAction (#926)", () => {
  async function runConfirm(store: WorthlineStore): Promise<string> {
    try {
      await confirmSnapshotPriceCorrectionAction("gold", correctionForm(), store);
      throw new Error("action did not redirect");
    } catch (err: unknown) {
      const e = err as { message?: string; digest?: string };
      if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") return e.digest;
      throw err;
    }
  }

  test("applies the correction and redirects", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const digest = await runConfirm(store);
    expect(digest).toContain("snapshot_price_corrected");
    expect(digest).toContain("date=2026-07-09");

    const row = (
      await store.snapshots.readSnapshotHoldings({ holdingId: "gold", kind: "asset" })
    ).find((r) => r.dateKey === "2026-07-09");
    expect(row?.unitPrice).toBe("12.5");
    expect(row?.valueMinor).toBe(3750);
    store.close();
  });
});
