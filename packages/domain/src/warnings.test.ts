import { describe, expect, test } from "vitest";

import type { ManualAsset } from "./index";
import { collectWarnings } from "./warnings";

function asset(id: string, name: string, amountMinor: number): ManualAsset {
  return {
    id,
    name,
    currentValue: { amountMinor, currency: "EUR" },
  } as ManualAsset;
}

describe("collectWarnings", () => {
  test("flags zero-value assets as overrideable", () => {
    const warnings = collectWarnings([
      asset("a1", "Cuenta", 0),
      asset("a2", "Piso", 100),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "ZERO_VALUE_ASSET",
      entityId: "a1",
      entityType: "asset",
      severity: "overrideable",
    });
  });

  test("suppresses an overrideable warning that has a matching override", () => {
    const warnings = collectWarnings(
      [asset("a1", "Cuenta", 0)],
      [{ code: "ZERO_VALUE_ASSET", entityId: "a1" }],
    );

    expect(warnings).toEqual([]);
  });

  test("an override for a different entity or code does not suppress the warning", () => {
    expect(
      collectWarnings(
        [asset("a1", "Cuenta", 0)],
        [{ code: "ZERO_VALUE_ASSET", entityId: "other" }],
      ),
    ).toHaveLength(1);
    expect(
      collectWarnings(
        [asset("a1", "Cuenta", 0)],
        [{ code: "OTHER_CODE", entityId: "a1" }],
      ),
    ).toHaveLength(1);
  });
});
