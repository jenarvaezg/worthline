import { describe, expect, test } from "vitest";

import {
  absoluteRefreshDate,
  boardRefreshHover,
  detailRefreshCaption,
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

describe("absoluteRefreshDate", () => {
  test("renders an es-ES day-month-year date", () => {
    expect(absoluteRefreshDate("2026-06-08T09:30:00.000Z")).toBe("8 jun 2026");
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

describe("detailRefreshCaption", () => {
  test("builds the absolute caption with the source label", () => {
    expect(detailRefreshCaption("2026-06-08T09:30:00.000Z", "yahoo")).toBe(
      "Precio actualizado el 8 jun 2026 · Yahoo",
    );
  });

  test("is null when metadata is missing", () => {
    expect(detailRefreshCaption(null, "yahoo")).toBeNull();
    expect(detailRefreshCaption("2026-06-08T09:30:00.000Z", null)).toBeNull();
  });
});
