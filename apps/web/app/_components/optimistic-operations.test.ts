import type { InvestmentOperation } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { applyOperationMutations, parseOperationDraft } from "./optimistic-operations";

/**
 * The pure optimistic-merge for the investment operations editor (#521, S5 of
 * #485, interaction-patterns §4/§7). Recording an operation redirects back to the
 * same /patrimonio/[id]/editar page, so the new row can show in the list BEFORE
 * the action resolves; a delete can vanish its row the same way. Only the
 * operation ROW is faked (it is exactly what the user typed) — the derived
 * units/value/PnL in the context header are server-computed and NOT predictable,
 * so they are left to settle on the redirect (§4). Pure (no React) so the merge
 * unit-tests in the node env while the editor stays a thin `useOptimistic` shell.
 */

function op(id: string, executedAt: string): InvestmentOperation {
  return {
    id,
    assetId: "asset-1",
    kind: "buy",
    executedAt,
    units: "10" as InvestmentOperation["units"],
    pricePerUnit: "100" as InvestmentOperation["pricePerUnit"],
    currency: "EUR",
    feesMinor: 0,
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) {
    fd.set(key, value);
  }
  return fd;
}

describe("applyOperationMutations · add", () => {
  test("includes the new operation in the list", () => {
    const base = [op("o1", "2026-01-01")];

    const next = applyOperationMutations(base, [
      { kind: "add", operation: op("o2", "2026-02-01") },
    ]);

    expect(next.map((o) => o.id)).toEqual(["o1", "o2"]);
  });

  test("never mutates the base list", () => {
    const base = [op("o1", "2026-01-01")];

    applyOperationMutations(base, [{ kind: "add", operation: op("o2", "2026-02-01") }]);

    expect(base).toHaveLength(1);
  });
});

describe("applyOperationMutations · delete", () => {
  test("removes the operation with the given id", () => {
    const base = [op("o1", "2026-01-01"), op("o2", "2026-02-01")];

    const next = applyOperationMutations(base, [{ kind: "delete", id: "o1" }]);

    expect(next.map((o) => o.id)).toEqual(["o2"]);
  });
});

describe("parseOperationDraft", () => {
  test("builds the optimistic row from the record form", () => {
    const draft = parseOperationDraft(
      form({
        kind: "sell",
        executedAt: "2026-03-15",
        units: "5",
        pricePerUnit: "200,50",
        fees: "1,20",
      }),
      "asset-1",
      "2026-06-24",
      "optimistic-1",
    );

    expect(draft).toEqual({
      id: "optimistic-1",
      assetId: "asset-1",
      kind: "sell",
      executedAt: "2026-03-15",
      units: "5",
      pricePerUnit: "200,50",
      currency: "EUR",
      feesMinor: 1_20,
    });
  });

  test("defaults the date to today and fees to zero", () => {
    const draft = parseOperationDraft(
      form({ units: "5", pricePerUnit: "200" }),
      "asset-1",
      "2026-06-24",
      "optimistic-1",
    );

    expect(draft?.executedAt).toBe("2026-06-24");
    expect(draft?.kind).toBe("buy");
    expect(draft?.feesMinor).toBe(0);
  });

  test("returns null when units or price is blank (no ghost row)", () => {
    expect(
      parseOperationDraft(form({ units: "", pricePerUnit: "200" }), "a", "t", "id"),
    ).toBeNull();
    expect(
      parseOperationDraft(form({ units: "5", pricePerUnit: "" }), "a", "t", "id"),
    ).toBeNull();
  });
});
