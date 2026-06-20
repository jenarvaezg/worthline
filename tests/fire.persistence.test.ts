import { afterEach, describe, expect, test } from "vitest";

import { createFileBackedStore, cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

describe("FIRE config persistence", () => {
  test("saveFireConfig then readFireConfig round-trips the config", async () => {
    const store = await createFileBackedStore("worthline-fire-");

    const config = {
      monthlySpendingMinor: 200_000,
      safeWithdrawalRate: 0.04,
      expectedRealReturn: 0.07,
      currentAge: 35,
      targetRetirementAge: 55,
      excludedAssetIds: [],
    };

    await store.saveFireConfig("household", config);
    const result = await store.readFireConfig();

    expect(result["household"]).toEqual(config);
  });

  test("saving scope2 config does not overwrite scope1 config", async () => {
    const store = await createFileBackedStore("worthline-fire-");

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

    await store.saveFireConfig("scope1", config1);
    await store.saveFireConfig("scope2", config2);
    const result = await store.readFireConfig();

    expect(result["scope1"]).toEqual(config1);
    expect(result["scope2"]).toEqual(config2);
  });

  test("readFireConfig returns {} when nothing stored", async () => {
    const store = await createFileBackedStore("worthline-fire-");

    expect(await store.readFireConfig()).toEqual({});
  });
});
