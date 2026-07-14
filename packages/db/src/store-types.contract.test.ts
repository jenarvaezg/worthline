import type { WorthlineStore } from "@worthline/db";
import { describe, expectTypeOf, test } from "vitest";

describe("public WorthlineStore mutation boundary", () => {
  test("exposes intent commands without raw dated-fact or UnitOfWork hooks", () => {
    expectTypeOf<WorthlineStore["command"]>().toHaveProperty("recordInvestmentOperation");
    expectTypeOf<WorthlineStore["command"]>().not.toHaveProperty("uow");
    expectTypeOf<WorthlineStore["command"]>().not.toHaveProperty("rippleDebtRebaseline");
    expectTypeOf<WorthlineStore["operations"]>().not.toHaveProperty("recordOperation");
    expectTypeOf<WorthlineStore["assets"]>().not.toHaveProperty("addValuationAnchor");
    expectTypeOf<WorthlineStore["assets"]>().not.toHaveProperty("updateAsset");
    expectTypeOf<WorthlineStore["liabilities"]>().not.toHaveProperty(
      "addBalanceRebaseline",
    );
    expectTypeOf<WorthlineStore["liabilities"]>().not.toHaveProperty("updateLiability");
    expectTypeOf<WorthlineStore["connectedSources"]>().not.toHaveProperty(
      "syncPositions",
    );
  });
});
