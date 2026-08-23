/**
 * /historico temporal window (#1535). Default last 12 months; `range=all`
 * (and 3A/5A) expand. Distinct from the dashboard's range pills, whose omitted
 * default is `all` because the home preloads alternatives.
 */

import { describe, expect, test } from "vitest";
import {
  historicoRangeHref,
  historicoWindowFrom,
  parseHistoricoRangeParam,
} from "./historico-range";

describe("parseHistoricoRangeParam", () => {
  test("defaults to 1y when the param is missing or unknown", () => {
    expect(parseHistoricoRangeParam(undefined)).toBe("1y");
    expect(parseHistoricoRangeParam("nonsense")).toBe("1y");
    expect(parseHistoricoRangeParam(["3y", "1y"])).toBe("3y");
  });

  test("accepts the known composition ranges", () => {
    expect(parseHistoricoRangeParam("1y")).toBe("1y");
    expect(parseHistoricoRangeParam("3y")).toBe("3y");
    expect(parseHistoricoRangeParam("5y")).toBe("5y");
    expect(parseHistoricoRangeParam("all")).toBe("all");
  });
});

describe("historicoWindowFrom", () => {
  test("1y is the first day of the month 11 months before today", () => {
    expect(historicoWindowFrom("2026-08-23", "1y")).toBe("2025-09-01");
  });

  test("all is unbounded", () => {
    expect(historicoWindowFrom("2026-08-23", "all")).toBeUndefined();
  });
});

describe("historicoRangeHref", () => {
  test("omits range when it is the 1y default", () => {
    expect(historicoRangeHref("", "1y")).toBe("/historico");
    expect(historicoRangeHref("?range=all", "1y")).toBe("/historico");
  });

  test("sets range for an expanded window and preserves other params", () => {
    expect(historicoRangeHref("", "all")).toBe("/historico?range=all");
    expect(historicoRangeHref("?scope=household", "3y")).toBe(
      "/historico?scope=household&range=3y",
    );
  });
});
