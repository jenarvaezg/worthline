/**
 * Wiring suite: housing-action seam fix (#152 adversarial review, fix 1).
 *
 * Before this fix the four housing server actions guarded on
 * `asset.type !== "real_estate"`, which rejected a cash/manual asset with
 * `isPrimaryResidence: true` even though `valuationMethodOfAsset` dispatches it
 * to the `appreciating` surface (via `isHousingAsset → instrument = property`).
 *
 * After the fix the guards use `!isHousingAsset(asset)`, aligning the action
 * seam with the dispatch seam. This suite confirms:
 *   1. A `cash` + `isPrimaryResidence` asset dispatches to `appreciating`.
 *   2. `setAppreciationRateAction` ACCEPTS it (was rejected before fix).
 *   3. `addValuationAnchorAction` ACCEPTS it (was rejected before fix).
 *   4. A plain `cash` (not primary residence) is still rejected by both.
 *   5. A `real_estate` asset still works (regression guard).
 */

import { vi, describe, test, expect, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { valuationMethodOfAsset } from "@worthline/domain";
import {
  addValuationAnchorAction,
  setAppreciationRateAction,
} from "../apps/web/app/patrimonio/actions";
import { catchRedirect, errorMessageOf, fd } from "./helpers";

const MEMBER_ID = "member_yo";
const CASH_RESIDENCE_ID = "asset_cash_primary";
const PLAIN_CASH_ID = "asset_cash_plain";
const REAL_ESTATE_ID = "asset_real_estate";

let store: WorthlineStore;

afterEach(() => {
  store?.close();
});

function setupStore() {
  store = createInMemoryStore();
  store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Yo" }],
    mode: "individual",
  });
  store.assets.createManualAsset({
    id: CASH_RESIDENCE_ID,
    name: "Vivienda habitual (cash)",
    type: "cash",
    currency: "EUR",
    currentValueMinor: 200_000_00,
    liquidityTier: "illiquid",
    isPrimaryResidence: true,
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
  store.assets.createManualAsset({
    id: PLAIN_CASH_ID,
    name: "Efectivo",
    type: "cash",
    currency: "EUR",
    currentValueMinor: 5_000_00,
    liquidityTier: "cash",
    isPrimaryResidence: false,
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
  store.assets.createManualAsset({
    id: REAL_ESTATE_ID,
    name: "Piso",
    type: "real_estate",
    currency: "EUR",
    currentValueMinor: 300_000_00,
    liquidityTier: "illiquid",
    isPrimaryResidence: false,
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
}

describe("housing action seam — isHousingAsset guard (#152 fix 1)", () => {
  test("cash + isPrimaryResidence dispatches to appreciating method", () => {
    setupStore();
    const asset = store.assets.readAssets().find((a) => a.id === CASH_RESIDENCE_ID)!;
    expect(valuationMethodOfAsset(asset)).toBe("appreciating");
  });

  test("setAppreciationRateAction accepts a cash+isPrimaryResidence asset", async () => {
    setupStore();
    const url = await catchRedirect(() =>
      setAppreciationRateAction(
        fd(
          { id: CASH_RESIDENCE_ID, rate: "3.5" },
          `/patrimonio/${CASH_RESIDENCE_ID}/editar`,
        ),
        store,
      ),
    );
    expect(url).toContain("ok=rate_saved");
  });

  test("addValuationAnchorAction accepts a cash+isPrimaryResidence asset", async () => {
    setupStore();
    const url = await catchRedirect(() =>
      addValuationAnchorAction(
        fd(
          {
            id: CASH_RESIDENCE_ID,
            valuationDate: "2023-01-01",
            anchorValue: "200000",
            adjustsPriorCurve: "on",
          },
          `/patrimonio/${CASH_RESIDENCE_ID}/editar`,
        ),
        store,
      ),
    );
    expect(url).toContain("ok=anchor_added");
  });

  test("setAppreciationRateAction still rejects a plain cash asset", async () => {
    setupStore();
    const url = await catchRedirect(() =>
      setAppreciationRateAction(
        fd({ id: PLAIN_CASH_ID, rate: "3.5" }, `/patrimonio/${PLAIN_CASH_ID}/editar`),
        store,
      ),
    );
    expect(errorMessageOf(url)).toMatch(/inmuebles/);
  });

  test("addValuationAnchorAction still rejects a plain cash asset", async () => {
    setupStore();
    const url = await catchRedirect(() =>
      addValuationAnchorAction(
        fd(
          {
            id: PLAIN_CASH_ID,
            valuationDate: "2023-01-01",
            anchorValue: "200000",
            adjustsPriorCurve: "on",
          },
          `/patrimonio/${PLAIN_CASH_ID}/editar`,
        ),
        store,
      ),
    );
    expect(errorMessageOf(url)).toMatch(/inmuebles/);
  });

  test("setAppreciationRateAction still works for a real_estate asset (regression)", async () => {
    setupStore();
    const url = await catchRedirect(() =>
      setAppreciationRateAction(
        fd({ id: REAL_ESTATE_ID, rate: "2.0" }, `/patrimonio/${REAL_ESTATE_ID}/editar`),
        store,
      ),
    );
    expect(url).toContain("ok=rate_saved");
  });
});
