import {
  createManualAsset,
  createWorkspace,
  type Income,
  type ManualAsset,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { doubleCountNotice } from "./double-count-notice";

const workspace = createWorkspace({
  members: [{ id: "member_jose", name: "Jose" }],
  mode: "individual",
});

const PLAN: ManualAsset = createManualAsset(workspace, {
  currency: "EUR",
  currentValueMinor: 52_300_00,
  id: "asset_plan",
  instrument: "pension_plan",
  liquidityTier: "term-locked",
  name: "Plan Indexa",
  ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
  type: "investment",
});

const VITALICIA: Income = {
  amountBasis: "real",
  amountMinor: 300_00,
  assumedContributionThrough: null,
  cadence: "monthly",
  endISO: null,
  exclusions: [],
  holdingId: "asset_plan",
  id: "inc_vitalicia",
  label: "Renta vitalicia",
  nature: "passive",
  provenance: null,
  provenanceAsOf: null,
  startISO: "2026-01-01",
};

describe("doubleCountNotice (#1675)", () => {
  test("un plan con valor y una renta ligada lleva la frase del motor", () => {
    expect(
      doubleCountNotice({
        asset: PLAN,
        incomes: [VITALICIA],
        overrides: [],
        todayISO: "2026-10-11",
      }),
    ).toContain("«Plan Indexa» tiene valor y además una renta declarada ligada a él");
  });

  test("reconocido como intencional, la ficha deja de preguntar", () => {
    expect(
      doubleCountNotice({
        asset: PLAN,
        incomes: [VITALICIA],
        overrides: [{ code: "INCOME_DOUBLE_COUNT", entityId: "asset_plan" }],
        todayISO: "2026-10-11",
      }),
    ).toBeNull();
  });

  test("el reconocimiento de OTRO aviso del mismo holding no lo apaga", () => {
    expect(
      doubleCountNotice({
        asset: PLAN,
        incomes: [VITALICIA],
        overrides: [{ code: "ZERO_VALUE_ASSET", entityId: "asset_plan" }],
        todayISO: "2026-10-11",
      }),
    ).not.toBeNull();
  });
});
