/**
 * One property's curve input, assembled from its rows (#1847, #1824 review).
 *
 * The board (`readHousingCurveInputs`, every live property at once) and the ficha
 * (the rows of ONE property it already read to render them) used to build this
 * object each in its own way. Both now ask `housingCurveInput`, so the figure on the
 * ficha's header is the board row's by construction. These tests pin the shape, and
 * that the board's batch read still hands out exactly what it did before.
 */
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

import { readHousingCurveInputs } from "./curve-valued-holdings";
import { housingCurveInput } from "./housing-curve-input";
import { openDrizzle, openLibsqlClient } from "./libsql-client";
import { createStoreFromSqlite, type PersistenceTestStore } from "./testing";

/** An anchor as the store hands it out: with the plumbing the curve must not carry. */
const APPRAISAL_ROW = {
  adjustsPriorCurve: true,
  assetId: "asset_piso",
  id: "anchor_1",
  kind: null,
  source: "manual" as const,
  valuationDate: "2024-03-15",
  valueMinor: 180_000_00,
};

describe("housingCurveInput", () => {
  test("carries the anchors, the rate, the cadence and the basis — and nothing of the rows' plumbing", () => {
    expect(
      housingCurveInput({
        anchors: [APPRAISAL_ROW],
        annualAppreciationRate: "0.03",
        cadence: "interpolated",
        currentValueMinor: 200_000_00,
      }),
    ).toEqual({
      anchors: [
        { adjustsPriorCurve: true, valuationDate: "2024-03-15", valueMinor: 180_000_00 },
      ],
      annualAppreciationRate: "0.03",
      cadence: "interpolated",
      currentValueMinor: 200_000_00,
    });
  });

  test("with no cadence stored the key is absent, which the engine reads as `step`", () => {
    expect(
      housingCurveInput({
        anchors: [],
        annualAppreciationRate: null,
        cadence: null,
        currentValueMinor: 90_000_00,
      }),
    ).toEqual({
      anchors: [],
      annualAppreciationRate: null,
      currentValueMinor: 90_000_00,
    });
  });
});

async function seed(): Promise<{ client: Client; store: PersistenceTestStore }> {
  const client = openLibsqlClient(":memory:");
  const store = await createStoreFromSqlite(client);
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Jose" }],
    mode: "individual",
  });
  for (const [id, type] of [
    ["piso_curva", "real_estate"],
    ["piso_desnudo", "real_estate"],
    ["cuenta", "cash"],
  ] as const) {
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id,
      liquidityTier: type === "cash" ? "cash" : "illiquid",
      name: id,
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
      type,
    });
  }
  await store.assets.addValuationAnchor({
    adjustsPriorCurve: true,
    assetId: "piso_curva",
    id: "anchor_tasacion",
    valuationDate: "2024-03-15",
    valueMinor: 180_000_00,
  });
  await store.assets.addValuationAnchor({
    adjustsPriorCurve: false,
    assetId: "piso_curva",
    id: "anchor_mejora",
    valuationDate: "2025-06-01",
    valueMinor: 12_000_00,
  });
  await store.assets.setAnnualAppreciationRate("piso_curva", "0.03");
  await store.assets.setValuationCadence("piso_curva", "interpolated");
  return { client, store };
}

describe("readHousingCurveInputs — the board's batch read, through the same function", () => {
  test("hands out exactly the curve inputs it handed out before", async () => {
    const { client, store } = await seed();
    const inputs = await readHousingCurveInputs(
      openDrizzle(client),
      await store.assets.readAssets(),
    );

    // The shapes the board's read built inline before the extraction, literal. The
    // cash account is not housing, so no entry; the bare flat has one, on its basis.
    expect(Object.fromEntries(inputs)).toEqual({
      piso_curva: {
        anchors: [
          {
            adjustsPriorCurve: true,
            valuationDate: "2024-03-15",
            valueMinor: 180_000_00,
          },
          {
            adjustsPriorCurve: false,
            valuationDate: "2025-06-01",
            valueMinor: 12_000_00,
          },
        ],
        annualAppreciationRate: "0.03",
        cadence: "interpolated",
        currentValueMinor: 200_000_00,
      },
      piso_desnudo: {
        anchors: [],
        annualAppreciationRate: null,
        currentValueMinor: 200_000_00,
      },
    });
    client.close();
  });
});
