/**
 * Unit tests for the pure coin-collection catalogue view helpers (PRD #160 /
 * #163, variant B). They cover the maths the React render relies on: true
 * percentages, the floored+re-normalized strip widths, the basis tags, and the
 * metal-identity fallbacks — no React, no DB.
 */

import type { CoinPosition, MetalGroup } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  basisTag,
  buildCoinCollectionView,
  coinNumistaUrl,
  coinYear,
  formatSharePct,
  MIN_SHARE_PCT,
  metalCoinCount,
  metalIdentity,
} from "./coin-collection-view";

function position(overrides: Partial<CoinPosition> = {}): CoinPosition {
  return {
    kind: "coin",
    id: "p1",
    sourceId: "s1",
    externalId: "ext-p1",
    catalogueId: "1",
    name: "Moneda",
    grade: "MBC",
    quantity: 1,
    year: null,
    liquidityTier: "illiquid",
    metal: "gold",
    issueId: null,
    finenessMillis: null,
    weightGrams: null,
    purchaseDate: null,
    metalValueMinor: null,
    numismaticValueMinor: null,
    numismaticFetchedAt: null,
    purchasePriceMinor: null,
    obverseThumbUrl: null,
    currency: "EUR",
    ...overrides,
  };
}

function group(overrides: Partial<MetalGroup>): MetalGroup {
  return { metal: "gold", positions: [], subtotalMinor: 0, ...overrides };
}

describe("coinNumistaUrl", () => {
  test("builds the public es.numista.com link from the catalogue id (the Numista type id)", () => {
    expect(coinNumistaUrl("1493")).toBe("https://es.numista.com/1493");
  });

  test("trims surrounding whitespace before building the link", () => {
    expect(coinNumistaUrl("  1493 ")).toBe("https://es.numista.com/1493");
  });

  test("returns null for a blank catalogue id so the name renders as plain text, not a broken link", () => {
    expect(coinNumistaUrl("")).toBeNull();
    expect(coinNumistaUrl("   ")).toBeNull();
  });
});

describe("coinYear", () => {
  test("shows the coin's mint year from the position, not its acquisition date", () => {
    expect(coinYear(position({ year: 1889, purchaseDate: "2019-05-12" }))).toBe("1889");
  });

  test("shows no year when the catalogue records none (no fabricated value)", () => {
    expect(coinYear(position({ year: null, purchaseDate: "2019-05-12" }))).toBeNull();
  });
});

describe("metalIdentity", () => {
  test("maps a known metal slug to its es-ES label and a decorative tone", () => {
    expect(metalIdentity("gold")).toEqual({ label: "Oro", tone: "var(--coin-gold)" });
    expect(metalIdentity("SILVER").label).toBe("Plata");
  });

  test("an unknown slug keeps the raw slug as label with a neutral tone", () => {
    expect(metalIdentity("orichalcum")).toEqual({
      label: "orichalcum",
      tone: "var(--line)",
    });
  });

  test("a null metal collapses to the 'Sin metal' identity", () => {
    expect(metalIdentity(null).label).toBe("Sin metal");
  });
});

describe("basisTag", () => {
  test("each valuation basis maps to a label + class", () => {
    expect(basisTag("metal")).toEqual({ label: "Metal", cls: "coinTagMetal" });
    expect(basisTag("numismatic").label).toBe("Colección");
    expect(basisTag("purchase").label).toBe("Compra");
    expect(basisTag("zero")).toEqual({ label: "Sin valor", cls: "coinTagZero" });
  });
});

describe("formatSharePct", () => {
  test("rounds whole shares, floors a sub-1% to '<1 %', and a zero to '0 %'", () => {
    expect(formatSharePct(82.4)).toBe("82 %");
    expect(formatSharePct(0.2)).toBe("<1 %");
    expect(formatSharePct(0)).toBe("0 %");
  });
});

describe("metalCoinCount", () => {
  test("sums position quantities, not the number of lines", () => {
    expect(metalCoinCount([position({ quantity: 3 }), position({ quantity: 2 })])).toBe(
      5,
    );
  });
});

describe("buildCoinCollectionView", () => {
  test("computes true percentages and a coin count off the groups", () => {
    const view = buildCoinCollectionView(
      [
        group({ metal: "gold", subtotalMinor: 8_000, positions: [position()] }),
        group({
          metal: "silver",
          subtotalMinor: 2_000,
          positions: [position({ metal: "silver", quantity: 4 })],
        }),
      ],
      10_000,
    );

    expect(view.totalMinor).toBe(10_000);
    expect(view.coinCount).toBe(5);
    expect(view.rows.map((r) => Math.round(r.pct))).toEqual([80, 20]);
  });

  test("a tiny metal is floored to MIN_SHARE_PCT in its bar but keeps its true pct", () => {
    const view = buildCoinCollectionView(
      [
        group({ metal: "gold", subtotalMinor: 9_980, positions: [position()] }),
        group({
          metal: "bronze",
          subtotalMinor: 20,
          positions: [position({ metal: "bronze" })],
        }),
      ],
      10_000,
    );

    const bronze = view.rows.find((r) => r.metal === "bronze")!;
    expect(bronze.barWidth).toBe(MIN_SHARE_PCT);
    expect(bronze.pct).toBeCloseTo(0.2, 5);
  });

  test("strip segments re-normalize the floored widths back to 100 %", () => {
    const view = buildCoinCollectionView(
      [
        group({ metal: "gold", subtotalMinor: 9_980, positions: [position()] }),
        group({
          metal: "bronze",
          subtotalMinor: 20,
          positions: [position({ metal: "bronze" })],
        }),
      ],
      10_000,
    );

    const sum = view.segments.reduce((acc, seg) => acc + seg.width, 0);
    expect(sum).toBeCloseTo(100, 5);
  });

  test("an empty / zero-total collection yields zero pct and no NaN widths", () => {
    const view = buildCoinCollectionView(
      [group({ metal: "bronze", subtotalMinor: 0, positions: [position()] })],
      0,
    );

    expect(view.rows[0]!.pct).toBe(0);
    expect(view.segments[0]!.width).toBeCloseTo(100, 5);
    expect(Number.isNaN(view.segments[0]!.width)).toBe(false);
  });
});
