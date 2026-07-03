import { describe, expect, test } from "vitest";

import { checkSinglePrimaryResidence } from "./index";

const casa = { id: "casa", isPrimaryResidence: true, name: "Casa" };
const piso = { id: "piso", isPrimaryResidence: false, name: "Piso" };

describe("checkSinglePrimaryResidence", () => {
  test("a second primary residence is a violation naming the current one", () => {
    expect(
      checkSinglePrimaryResidence([casa, piso], { isPrimaryResidence: true }),
    ).toEqual({ code: "duplicate_primary_residence", existingName: "Casa" });
  });

  test("the first primary residence is valid", () => {
    expect(checkSinglePrimaryResidence([piso], { isPrimaryResidence: true })).toBeNull();
  });

  test("an edit re-affirming the asset's own flag is valid", () => {
    expect(
      checkSinglePrimaryResidence([casa, piso], {
        assetId: "casa",
        isPrimaryResidence: true,
      }),
    ).toBeNull();
  });

  test("a non-primary candidate never violates", () => {
    expect(checkSinglePrimaryResidence([casa], { isPrimaryResidence: false })).toBeNull();
  });
});
