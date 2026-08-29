import { describe, expect, test } from "vitest";

import {
  BOARD_FOLD_PARAM,
  readOpenPortfolios,
  readOpenPortfoliosFromUrl,
  toggleOpenPortfolio,
  urlWithOpenPortfolios,
} from "./board-fold";

const metal = "wl_prt_metal1";
const otra = "wl_prt_otra22";

describe("readOpenPortfolios", () => {
  test("no param means every group is collapsed", () => {
    expect([...readOpenPortfolios(new URLSearchParams(""))]).toEqual([]);
  });

  test("reads a comma-separated list of public ids", () => {
    const open = readOpenPortfolios(
      new URLSearchParams(`${BOARD_FOLD_PARAM}=${metal},${otra}`),
    );
    expect([...open].sort()).toEqual([metal, otra].sort());
  });

  test("drops anything that is not a public portfolio id", () => {
    const open = readOpenPortfolios(
      new URLSearchParams(`${BOARD_FOLD_PARAM}=${metal},asset_internal,,wl_hld_x`),
    );
    expect([...open]).toEqual([metal]);
  });

  test("reads from a full URL too", () => {
    expect([
      ...readOpenPortfoliosFromUrl(`/patrimonio?g=rung&${BOARD_FOLD_PARAM}=${metal}`),
    ]).toEqual([metal]);
    expect([...readOpenPortfoliosFromUrl("/patrimonio")]).toEqual([]);
  });
});

describe("toggleOpenPortfolio", () => {
  test("opens what was closed and closes what was open", () => {
    const opened = toggleOpenPortfolio(new Set(), metal);
    expect([...opened]).toEqual([metal]);
    expect([...toggleOpenPortfolio(opened, metal)]).toEqual([]);
  });

  test("never mutates the set it was given", () => {
    const before = new Set([metal]);
    toggleOpenPortfolio(before, otra);
    expect([...before]).toEqual([metal]);
  });
});

describe("urlWithOpenPortfolios", () => {
  test("writes the open set, sorted, so one state is one URL", () => {
    expect(urlWithOpenPortfolios("/patrimonio", new Set([otra, metal]))).toBe(
      `/patrimonio?${BOARD_FOLD_PARAM}=${[metal, otra].sort().join(",")}`,
    );
  });

  test("keeps the other params (the grouping axis survives a fold)", () => {
    expect(urlWithOpenPortfolios("/patrimonio?g=instrument", new Set([metal]))).toBe(
      `/patrimonio?g=instrument&${BOARD_FOLD_PARAM}=${metal}`,
    );
  });

  test("the collapsed default leaves no param behind", () => {
    expect(
      urlWithOpenPortfolios(`/patrimonio?g=rung&${BOARD_FOLD_PARAM}=${metal}`, new Set()),
    ).toBe("/patrimonio?g=rung");
    expect(
      urlWithOpenPortfolios(`/patrimonio?${BOARD_FOLD_PARAM}=${metal}`, new Set()),
    ).toBe("/patrimonio");
  });
});
