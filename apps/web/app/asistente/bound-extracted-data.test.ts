import { describe, expect, it } from "vitest";

import { boundExtractedData, EXTRACTED_DATA_LIMITS } from "./bound-extracted-data";

describe("boundExtractedData (#1180)", () => {
  it("passes an ordinary extraction through untouched", () => {
    const extracted = {
      saldo: 587_900,
      fecha: "2026-07-15",
      filas: [{ concepto: "cuota", importe: -32_150 }],
    };
    expect(boundExtractedData(extracted)).toEqual(extracted);
  });

  it("truncates a string past the character cap and marks it", () => {
    const bounded = boundExtractedData({
      nota: "x".repeat(EXTRACTED_DATA_LIMITS.maxStringChars + 500),
    }) as { nota: string };

    expect(bounded.nota.length).toBeLessThan(EXTRACTED_DATA_LIMITS.maxStringChars + 40);
    expect(bounded.nota).toContain("…");
    expect(bounded.nota.startsWith("x".repeat(100))).toBe(true);
  });

  it("caps array length and says how many items it dropped", () => {
    const rows = Array.from(
      { length: EXTRACTED_DATA_LIMITS.maxArrayItems + 37 },
      (_, i) => ({
        i,
      }),
    );
    const bounded = boundExtractedData(rows) as unknown[];

    expect(bounded).toHaveLength(EXTRACTED_DATA_LIMITS.maxArrayItems + 1);
    expect(bounded[EXTRACTED_DATA_LIMITS.maxArrayItems]).toContain("37");
  });

  it("caps the number of object keys", () => {
    const wide = Object.fromEntries(
      Array.from({ length: EXTRACTED_DATA_LIMITS.maxObjectKeys + 20 }, (_, i) => [
        `k${i}`,
        i,
      ]),
    );
    const bounded = boundExtractedData(wide) as Record<string, unknown>;

    expect(Object.keys(bounded)).toHaveLength(EXTRACTED_DATA_LIMITS.maxObjectKeys + 1);
    expect(bounded["k0"]).toBe(0);
    expect(String(bounded[EXTRACTED_DATA_LIMITS.omittedKey])).toContain("20");
  });

  it("stops at the depth cap instead of recursing forever", () => {
    // A 200-deep chain: JSON.stringify would blow the stack long before /admin
    // ever rendered it.
    let deep: Record<string, unknown> = { fondo: "tocado" };
    for (let i = 0; i < 200; i += 1) deep = { nivel: deep };

    const bounded = boundExtractedData(deep);
    const serialized = JSON.stringify(bounded);

    expect(serialized).toContain("…");
    expect(serialized).not.toContain("tocado");
    expect(serialized.length).toBeLessThan(400);
  });

  it("survives a self-referencing object (the depth cap breaks the cycle)", () => {
    const cyclic: Record<string, unknown> = { saldo: 100 };
    cyclic["self"] = cyclic;

    const bounded = boundExtractedData(cyclic);
    expect(() => JSON.stringify(bounded)).not.toThrow();
  });

  it("replaces the whole blob when it still exceeds the serialized budget", () => {
    // Many rows, each individually legal: the per-node caps let it through but
    // the total is still far past what a control-plane row should carry.
    const bloated = Object.fromEntries(
      Array.from({ length: EXTRACTED_DATA_LIMITS.maxObjectKeys }, (_, i) => [
        `k${i}`,
        "y".repeat(EXTRACTED_DATA_LIMITS.maxStringChars),
      ]),
    );

    const bounded = boundExtractedData(bloated) as Record<string, unknown>;

    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(
      EXTRACTED_DATA_LIMITS.maxSerializedChars,
    );
    expect(String(bounded[EXTRACTED_DATA_LIMITS.omittedKey])).toMatch(/omitid/i);
  });

  it("drops values JSON cannot carry rather than emitting undefined", () => {
    const bounded = boundExtractedData({
      ok: 1,
      fn: () => 1,
      undef: undefined,
      big: 10n,
      nan: Number.NaN,
    }) as Record<string, unknown>;

    expect(bounded["ok"]).toBe(1);
    expect("fn" in bounded).toBe(false);
    expect("undef" in bounded).toBe(false);
    expect(bounded["big"]).toBe("10");
    expect(bounded["nan"]).toBeNull();
  });

  it("keeps undefined as absent so an optional payload key stays absent", () => {
    expect(boundExtractedData(undefined)).toBeUndefined();
  });

  it("leaves an explicit null alone (a fact, not a bloat vector)", () => {
    expect(boundExtractedData(null)).toBeNull();
  });
});
