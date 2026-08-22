import { describe, expect, it } from "vitest";

import { managedPortfoliosByAssetId } from "./managed-portfolio-membership";

describe("managedPortfoliosByAssetId", () => {
  const publicIds = new Map([
    ["p1", "wl_prt_1"],
    ["p2", "wl_prt_2"],
  ]);

  it("maps each member to its ONE portfolio (membership is exclusive)", () => {
    const byAsset = managedPortfoliosByAssetId(
      [
        {
          holdingIds: ["f1", "cash"],
          id: "p1",
          name: "Metal",
          provider: null,
          scopeId: "household",
        },
        {
          holdingIds: ["f2"],
          id: "p2",
          name: "Otra",
          provider: null,
          scopeId: "household",
        },
      ],
      publicIds,
    );

    expect(byAsset.get("f1")).toEqual({
      id: "wl_prt_1",
      label: "Metal",
      object: "managed_portfolio",
    });
    expect(byAsset.get("cash")?.label).toBe("Metal");
    expect(byAsset.get("f2")).toEqual({
      id: "wl_prt_2",
      label: "Otra",
      object: "managed_portfolio",
    });
  });

  it("skips a portfolio without a registry row instead of inventing an id", () => {
    const byAsset = managedPortfoliosByAssetId(
      [
        {
          holdingIds: ["f1"],
          id: "ghost",
          name: "Sin registro",
          provider: null,
          scopeId: "household",
        },
      ],
      publicIds,
    );

    expect(byAsset.size).toBe(0);
  });
});
