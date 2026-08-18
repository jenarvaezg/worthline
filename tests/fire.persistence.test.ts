import { afterEach, describe, expect, test } from "vitest";

import { cleanupTempDirs, createFileBackedStore } from "./helpers";

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

  // #1415: the reference age is derived from the member's birth date at the read,
  // so it cannot go stale. The bug this replaces: Jorge typed 62 in 2025 and the
  // app still served 62 in 2026 — his coast age, his years-to-retirement and the
  // three projected ages all a year young, always optimistically.
  describe("the reference age is derived from the birth date (#1415)", () => {
    const config = {
      monthlySpendingMinor: 200_000,
      safeWithdrawalRate: 0.04,
      excludedAssetIds: [],
    };

    test("a stale stored age is replaced by the age on the read date", async () => {
      const store = await createFileBackedStore("worthline-fire-");
      await store.workspace.initializeWorkspace({
        members: [{ id: "member_jorge", name: "Jorge", birthYear: 1963, birthMonth: 3 }],
        mode: "individual",
      });
      await store.saveFireConfig("household", { ...config, currentAge: 62 });

      expect((await store.readFireConfig("2026-08-18")).household?.currentAge).toBe(63);
    });

    test("the birth month decides the age inside the natural year", async () => {
      const store = await createFileBackedStore("worthline-fire-");
      await store.workspace.initializeWorkspace({
        members: [{ id: "member_jorge", name: "Jorge", birthYear: 1963, birthMonth: 12 }],
        mode: "individual",
      });
      await store.saveFireConfig("household", config);

      expect((await store.readFireConfig("2026-08-18")).household?.currentAge).toBe(62);
      expect((await store.readFireConfig("2026-12-01")).household?.currentAge).toBe(63);
    });

    test("a household scope takes the oldest member", async () => {
      const store = await createFileBackedStore("worthline-fire-");
      await store.workspace.initializeWorkspace({
        members: [
          { id: "member_jorge", name: "Jorge", birthYear: 1963 },
          { id: "member_ana", name: "Ana", birthYear: 1975 },
        ],
        mode: "household",
      });
      await store.saveFireConfig("household", config);
      await store.saveFireConfig("member_ana", config);

      const read = await store.readFireConfig("2026-08-18");
      expect(read.household?.currentAge).toBe(63);
      expect(read.member_ana?.currentAge).toBe(51);
    });

    test("a member with no birth date keeps the legacy typed age", async () => {
      // The silent failure guarded here: an age of `undefined` makes calculateFire
      // skip the coast block, so coastFireRequired / coastFireAge / isAlreadyAtCoastFire
      // vanish from the page with nothing said.
      const store = await createFileBackedStore("worthline-fire-");
      await store.workspace.initializeWorkspace({
        members: [{ id: "member_jose", name: "Jose" }],
        mode: "individual",
      });
      await store.saveFireConfig("household", { ...config, currentAge: 48 });

      expect((await store.readFireConfig("2026-08-18")).household?.currentAge).toBe(48);
    });

    test("saving the form again does not erase a legacy typed age", async () => {
      // The FIRE form no longer carries an age field, so the intake produces a
      // config without `currentAge`. A pre-#1415 workspace with no birth date must
      // not lose its only age because the user touched an unrelated field.
      const store = await createFileBackedStore("worthline-fire-");
      await store.workspace.initializeWorkspace({
        members: [{ id: "member_jose", name: "Jose" }],
        mode: "individual",
      });
      await store.saveFireConfig("household", { ...config, currentAge: 48 });

      await store.saveFireConfig("household", {
        ...config,
        monthlySpendingMinor: 250_000,
      });

      const read = await store.readFireConfig("2026-08-18");
      expect(read.household?.currentAge).toBe(48);
      expect(read.household?.monthlySpendingMinor).toBe(250_000);
    });

    test("the birth date wins over the legacy age even after a re-save", async () => {
      const store = await createFileBackedStore("worthline-fire-");
      await store.workspace.initializeWorkspace({
        members: [{ id: "member_jorge", name: "Jorge", birthYear: 1963 }],
        mode: "individual",
      });
      await store.saveFireConfig("household", { ...config, currentAge: 62 });
      await store.saveFireConfig("household", config);

      expect((await store.readFireConfig("2026-08-18")).household?.currentAge).toBe(63);
    });
  });
});
