import type { InvestmentOperation } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  compareOperationsForAgentView,
  deriveOperationPublicId,
} from "./holding-operations";

function operation(id: string): InvestmentOperation {
  return {
    assetId: "asset",
    currency: "EUR",
    executedAt: "2026-06-05",
    feesMinor: 0,
    id,
    kind: "buy",
    pricePerUnit: "1",
    units: "1",
  };
}

describe("agent-view operation ordering", () => {
  test("breaks same-date/same-time ties by internal operation id, not public id", () => {
    const lower = operation("op_02");
    const higher = operation("op_08");

    expect(lower.id.localeCompare(higher.id)).toBeLessThan(0);
    expect(
      deriveOperationPublicId(lower.id).localeCompare(deriveOperationPublicId(higher.id)),
    ).toBeGreaterThan(0);
    expect(compareOperationsForAgentView(lower, higher, "date")).toBeLessThan(0);
    expect(compareOperationsForAgentView(lower, higher, "-date")).toBeGreaterThan(0);
  });
});
