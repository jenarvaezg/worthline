import type { PersistenceTestStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { AssetFamilyContext, PayoutsPanel } from "./family-contract";
import { loadHousingSurface } from "./housing-family";

/**
 * The witness of #1847: a property's ficha quotes the figure its row on the board
 * quotes, from the same calculation — not the stored column, which is only the
 * curve's fallback basis and drifts from it as soon as there is a rate.
 *
 * Both sides run against one in-memory store: the board's read
 * (`readCurveValuedHoldingsAtDate`, what `load-patrimonio` values its rows with) and
 * the housing family's loader, on the same day. The flat carries what makes the two
 * diverge: an appraisal in the past, a rate, and the `interpolated` cadence that
 * compounds it by the day.
 */

const TODAY = "2026-10-13";
const ASSET_ID = "asset_piso";
const MEMBER_ID = "member_jose";

/** The shared Cobros panel, empty: it is not what this witness is about. */
const NO_PAYOUTS: PayoutsPanel = {
  count: 0,
  datedPayouts: [],
  entry: () => null,
  record: () => null,
  rows: { cobros: [], recurrentes: [] },
  section: null,
};

async function seedFlat(): Promise<PersistenceTestStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 200_000_00,
    id: ASSET_ID,
    liquidityTier: "illiquid",
    name: "Piso Centro",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    type: "real_estate",
  });
  await store.assets.addValuationAnchor({
    adjustsPriorCurve: true,
    assetId: ASSET_ID,
    id: "anchor_tasacion",
    valuationDate: "2024-03-15",
    valueMinor: 180_000_00,
  });
  await store.assets.setAnnualAppreciationRate(ASSET_ID, "0.03");
  await store.assets.setValuationCadence(ASSET_ID, "interpolated");
  await store.assets.setAcquisitionCostMinor(ASSET_ID, 150_000_00);
  return store;
}

async function fichaOf(store: PersistenceTestStore) {
  const asset = (await store.assets.readAssets()).find((a) => a.id === ASSET_ID);
  if (!asset) throw new Error("the flat was not seeded");
  const ctx: AssetFamilyContext = {
    allAssets: [asset],
    archiveOriginAfterTransfer: false,
    asset,
    baseCurrency: "EUR",
    checkedAt: `${TODAY}T08:00:00.000Z`,
    currentUrl: "/patrimonio/wl_hld_piso/editar",
    formError: null,
    id: ASSET_ID,
    isDemo: false,
    overrides: [],
    payoutsPanel: NO_PAYOUTS,
    privacyMode: false,
    // The page's store is the same surface the in-memory one exposes.
    store: store as never,
    today: TODAY,
  };
  const surface = await loadHousingSurface(ctx);
  if (surface.layout.kind !== "ficha") throw new Error("a property's ficha has tabs");
  return { asset, ficha: surface.layout.ficha };
}

describe("the property's ficha quotes its board row (#1847)", () => {
  test("the header's value is the curve's today, as the board values the row", async () => {
    const store = await seedFlat();
    const { asset, ficha } = await fichaOf(store);

    const board = await store.snapshots.readCurveValuedHoldingsAtDate(TODAY);
    const row = board.assets.find((a) => a.id === ASSET_ID);
    expect(row).toBeDefined();
    // The two figures this witness tells apart really are two.
    expect(row!.currentValue.amountMinor).not.toBe(asset.currentValue.amountMinor);

    expect(ficha.value).toBe(formatMoneyMinorPrivacy(row!.currentValue, false));

    store.close();
  });

  test("«Resultado frente al coste» is measured against that same value", async () => {
    const store = await seedFlat();
    const { ficha } = await fichaOf(store);

    const board = await store.snapshots.readCurveValuedHoldingsAtDate(TODAY);
    const row = board.assets.find((a) => a.id === ASSET_ID)!;
    const result = ficha.figures.find((figure) => figure.key === "result");

    expect(result?.value).toBe(
      `+${formatMoneyMinorPrivacy(
        { amountMinor: row.currentValue.amountMinor - 150_000_00, currency: "EUR" },
        false,
      )}`,
    );
    expect(result?.tone).toBe("pos");

    store.close();
  });

  test.each([
    {
      name: "an improvement layered on the appraisal",
      seed: (store: PersistenceTestStore) =>
        store.assets.addValuationAnchor({
          adjustsPriorCurve: false,
          assetId: ASSET_ID,
          id: "anchor_mejora",
          valuationDate: "2025-06-01",
          valueMinor: 12_000_00,
        }),
    },
    {
      name: "no anchor at all, valued from the stored basis",
      seed: (store: PersistenceTestStore) =>
        store.assets.deleteValuationAnchor("anchor_tasacion").then(() => undefined),
    },
  ])("$name: header and tab quote the board row alike", async ({ seed }) => {
    const store = await seedFlat();
    await seed(store);
    const { ficha } = await fichaOf(store);

    const board = await store.snapshots.readCurveValuedHoldingsAtDate(TODAY);
    const row = board.assets.find((a) => a.id === ASSET_ID)!;
    expect(ficha.value).toBe(formatMoneyMinorPrivacy(row.currentValue, false));

    // The «Valoración» tab's result line, measured against the same row.
    const valoracion = ficha.tabs.find((tab) => tab.key === "valoracion");
    const markup = renderToStaticMarkup(valoracion?.content as ReactElement);
    const expected = formatMoneyMinorPrivacy(
      { amountMinor: row.currentValue.amountMinor - 150_000_00, currency: "EUR" },
      false,
    );
    expect(markup).toContain(`>+${expected}</output>`);

    store.close();
  });
});
