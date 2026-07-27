import { walkDeep } from "@web/asistente/walk-deep";
import { describe, expect, it } from "vitest";

function visited(value: unknown): Array<[string | null, unknown]> {
  const seen: Array<[string | null, unknown]> = [];
  walkDeep(value, (key, nested) => {
    if (typeof nested === "object" && nested !== null) return;
    seen.push([key, nested]);
  });
  return seen;
}

describe("walkDeep", () => {
  it("carries the key of the array a value came from", () => {
    // The rule the reference reader depends on: `holdingIds: [a, b]` must read as two
    // values OF `holdingIds`, not as two anonymous strings.
    expect(visited({ holdingIds: ["a", "b"] })).toEqual([
      ["holdingIds", "a"],
      ["holdingIds", "b"],
    ]);
  });

  it("keys nested fields by their own name, however deep", () => {
    expect(visited({ segments: [{ liabilityId: "x" }] })).toEqual([["liabilityId", "x"]]);
  });

  it("visits the root with no key", () => {
    expect(visited("suelto")).toEqual([[null, "suelto"]]);
  });

  it("survives a cycle instead of killing the turn", () => {
    const cyclic: Record<string, unknown> = { holdingId: "a" };
    cyclic["self"] = cyclic;
    expect(() => visited(cyclic)).not.toThrow();
    expect(visited(cyclic)).toEqual([["holdingId", "a"]]);
  });

  it("visits an object before its contents, so a record can be read whole", () => {
    const records: unknown[] = [];
    walkDeep({ items: [{ id: "1", label: "uno" }] }, (_key, value) => {
      if (typeof value === "object" && value !== null && "label" in value) {
        records.push(value);
      }
    });
    expect(records).toEqual([{ id: "1", label: "uno" }]);
  });
});
