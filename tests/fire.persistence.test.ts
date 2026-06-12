import { afterEach, describe, expect, test } from "vitest";

import { createFileBackedStore, cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

describe("FIRE config persistence", () => {
  test("saveFireConfig then readFireConfig round-trips the config", () => {
    const store = createFileBackedStore("worthline-fire-");

    const config = {
      monthlySpendingMinor: 200_000,
      safeWithdrawalRate: 0.04,
      expectedRealReturn: 0.07,
      currentAge: 35,
      targetRetirementAge: 55,
      excludedAssetIds: [],
    };

    store.saveFireConfig("household", config);
    const result = store.readFireConfig();

    expect(result["household"]).toEqual(config);
  });

  test("saving scope2 config does not overwrite scope1 config", () => {
    const store = createFileBackedStore("worthline-fire-");

    const config1 = {
      monthlySpendingMinor: 150_000,
      safeWithdrawalRate: 0.04,
      expectedRealReturn: 0.07,
      excludedAssetIds: [],
    };
    const config2 = {
      monthlySpendingMinor: 300_000,
      safeWithdrawalRate: 0.035,
      expectedRealReturn: 0.06,
      excludedAssetIds: [],
    };

    store.saveFireConfig("scope1", config1);
    store.saveFireConfig("scope2", config2);
    const result = store.readFireConfig();

    expect(result["scope1"]).toEqual(config1);
    expect(result["scope2"]).toEqual(config2);
  });

  test("readFireConfig returns {} when nothing stored", () => {
    const store = createFileBackedStore("worthline-fire-");

    expect(store.readFireConfig()).toEqual({});
  });
});
