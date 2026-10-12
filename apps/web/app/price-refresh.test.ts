import { describe, expect, test } from "vitest";

import {
  boardRefreshHover,
  priceOriginCaption,
  priceSourceLabel,
  relativeRefreshDate,
} from "./price-refresh";

describe("priceSourceLabel", () => {
  test("maps investment provider codes to short es-ES labels", () => {
    expect(priceSourceLabel("yahoo")).toBe("Yahoo");
    expect(priceSourceLabel("stooq")).toBe("Stooq");
    expect(priceSourceLabel("finect")).toBe("Finect");
    expect(priceSourceLabel("coingecko")).toBe("CoinGecko");
  });

  test("covers the non-investment sources so the map never falls through", () => {
    expect(priceSourceLabel("manual")).toBe("Manual");
    expect(priceSourceLabel("binance")).toBe("Binance");
    expect(priceSourceLabel("numista")).toBe("Numista");
    expect(priceSourceLabel("ecb")).toBe("BCE");
  });
});

describe("relativeRefreshDate", () => {
  const now = "2026-06-10T12:00:00.000Z";

  test("'hoy' when fetched the same day", () => {
    expect(relativeRefreshDate("2026-06-10T08:00:00.000Z", now)).toBe("hoy");
  });

  test("'ayer' when one day old", () => {
    expect(relativeRefreshDate("2026-06-09T08:00:00.000Z", now)).toBe("ayer");
  });

  test("'hace N días' for older prices", () => {
    expect(relativeRefreshDate("2026-06-08T08:00:00.000Z", now)).toBe("hace 2 días");
    expect(relativeRefreshDate("2026-06-01T08:00:00.000Z", now)).toBe("hace 9 días");
  });

  test("never goes negative for a future stamp", () => {
    expect(relativeRefreshDate("2026-06-20T08:00:00.000Z", now)).toBe("hoy");
  });
});

describe("boardRefreshHover", () => {
  const now = "2026-06-10T12:00:00.000Z";

  test("builds the relative ' · ' suffix with the source label", () => {
    expect(boardRefreshHover("2026-06-08T08:00:00.000Z", "yahoo", now)).toBe(
      " · precio de hace 2 días, vía Yahoo",
    );
  });

  test("is null when either piece of metadata is missing", () => {
    expect(boardRefreshHover(null, "yahoo", now)).toBeNull();
    expect(boardRefreshHover("2026-06-08T08:00:00.000Z", null, now)).toBeNull();
    expect(boardRefreshHover(null, null, now)).toBeNull();
  });
});

describe("priceOriginCaption (#1828)", () => {
  const ok = { refreshFailed: false };

  test("a provider's quote, with the day it is from", () => {
    expect(
      priceOriginCaption({ ...ok, asOf: "2026-10-11", kind: "quote", provider: "yahoo" }),
    ).toBe("cotización Yahoo · 11/10/2026");
  });

  test("a hand-set price, with the day it was set", () => {
    expect(priceOriginCaption({ ...ok, asOf: "2026-10-03", kind: "manual" })).toBe(
      "precio a mano · 03/10/2026",
    );
  });

  test("no day it can vouch for, no day printed", () => {
    expect(
      priceOriginCaption({ ...ok, asOf: null, kind: "quote", provider: "finect" }),
    ).toBe("cotización Finect");
    // A hand-set price saved before every change was stamped: «a mano», and no
    // day invented or borrowed from anywhere else (#1731 review).
    expect(priceOriginCaption({ ...ok, asOf: null, kind: "manual" })).toBe(
      "precio a mano",
    );
  });

  test("a quote nobody can name the provider of is still a stored quote", () => {
    expect(
      priceOriginCaption({ ...ok, asOf: "2026-10-11", kind: "quote", provider: null }),
    ).toBe("cotización guardada · 11/10/2026");
  });

  test("no price at all: valued at what it cost", () => {
    expect(priceOriginCaption({ ...ok, kind: "cost" })).toBe(
      "sin precio: se valora a lo que costó",
    );
  });
});

describe("priceOriginCaption says a failed refresh (#1731 review)", () => {
  const failed = { refreshFailed: true };

  test("a quote kept from before the failure keeps its day, and says it is not up to date", () => {
    expect(
      priceOriginCaption({
        ...failed,
        asOf: "2026-10-08",
        kind: "quote",
        provider: "yahoo",
      }),
    ).toBe("cotización Yahoo · 08/10/2026 · no se pudo actualizar");
  });

  test("a kept quote with no day of its own is still said to be out of date, never dated by the attempt", () => {
    expect(
      priceOriginCaption({ ...failed, asOf: null, kind: "quote", provider: "yahoo" }),
    ).toBe("cotización Yahoo · no se pudo actualizar");
  });

  test("a hand-set price standing in for the quote says the quote failed", () => {
    expect(priceOriginCaption({ ...failed, asOf: "2026-10-03", kind: "manual" })).toBe(
      "precio a mano · 03/10/2026 · falló la cotización automática",
    );
  });

  test("valued at its cost because the quote failed: said so", () => {
    expect(priceOriginCaption({ ...failed, kind: "cost" })).toBe(
      "sin precio: falló la cotización y se valora a lo que costó",
    );
  });
});
