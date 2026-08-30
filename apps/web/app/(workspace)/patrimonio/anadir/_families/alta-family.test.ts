/**
 * The alta's routing decision (#1611).
 *
 * These tests pin the property the split exists for: every instrument the add
 * form offers has exactly ONE family, decided here and nowhere else. The table
 * below is exhaustive over `Instrument` — a new instrument that declares no way
 * to persist itself fails this file instead of silently falling into whichever
 * branch the action happened to test last.
 */

import type { Instrument } from "@worthline/domain";
import { describe, expect, test } from "vitest";
import { type AltaFamily, altaRoute } from "./alta-family";

/** Every instrument, and the family its alta belongs to. `null` = not hand-created. */
const FAMILY_BY_INSTRUMENT: Record<Instrument, AltaFamily | null> = {
  coin_collection: null,
  credit_card: "debt",
  crypto: "investment",
  current_account: "stored",
  etf: "investment",
  fund: "investment",
  index: "investment",
  loan: "debt",
  mortgage: "debt",
  other: "stored",
  pension_plan: "investment",
  precious_metal: "stored",
  property: "housing",
  stock: "investment",
  term_deposit: "stored",
  vehicle: "stored",
};

describe("altaRoute", () => {
  test.each(Object.entries(FAMILY_BY_INSTRUMENT))("%s → %s", (instrument, expected) => {
    expect(altaRoute(instrument as Instrument)?.family ?? null).toBe(expected);
  });

  test("a stored route carries the legacy AssetType the instrument persists as", () => {
    // The catalog's own distinction (#309): a current account is `cash`, every
    // other stored instrument is `manual`. The command must not re-derive it.
    expect(altaRoute("current_account")).toEqual({
      assetType: "cash",
      family: "stored",
      rung: "cash",
    });
    expect(altaRoute("term_deposit")).toEqual({
      assetType: "manual",
      family: "stored",
      rung: "term-locked",
    });
  });

  test("an investment route carries the provider the instrument is priced by", () => {
    expect(altaRoute("fund")).toEqual({
      family: "investment",
      priceProvider: "yahoo",
      rung: "market",
    });
    expect(altaRoute("pension_plan")).toEqual({
      family: "investment",
      priceProvider: "finect",
      rung: "term-locked",
    });
  });

  test("a debt route carries the liability spec, so the command needs no guard", () => {
    // The `loan` model here is only the DEFAULT — the debt command still lets
    // «Informal» override it (#273).
    expect(altaRoute("mortgage")).toEqual({
      family: "debt",
      liability: { debtModel: "amortizable", type: "mortgage" },
      rung: "illiquid",
    });
    expect(altaRoute("credit_card")).toEqual({
      family: "debt",
      liability: { debtModel: "revolving", type: "debt" },
      rung: "cash",
    });
  });

  test("housing is its own family, not a stored asset that happens to have a date", () => {
    // What separates them is the write: a property seeds an acquisition anchor
    // and ripples the histórico from it (PRD #108); a stored holding writes one
    // row. Routing them together is what made the alta branch twice.
    expect(altaRoute("property")).toEqual({ family: "housing", rung: "illiquid" });
  });
});
