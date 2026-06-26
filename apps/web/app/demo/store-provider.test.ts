/**
 * Demo store provider tests (S5 #386, ADR 0030). The provider is shallow plumbing
 * (the e2e journey is its main exercise), so these cover only its load-bearing
 * contract: it seeds a persona's workspace into a fresh ephemeral in-memory
 * libSQL database, and each call yields an INDEPENDENT database — so a viewer's
 * involuntary writes never leak from one request's store into the next.
 */
import { describe, expect, it } from "vitest";

import { getDemoStore, seedDemoStore } from "@web/demo/store-provider";

const AS_OF = "2026-06-19";

describe("demo store provider", () => {
  it("seeds and opens a usable familia store in memory", async () => {
    const store = await seedDemoStore("familia", AS_OF);
    const workspace = await store.workspace.readWorkspace();
    expect(workspace?.members.length).toBe(2);
    store.close();
  });

  it("gives each call an independent in-memory database (nothing persists)", async () => {
    const first = await seedDemoStore("familia", AS_OF);
    await first.assets.updateAssetValuation("asset_familia_checking", 99_999_00);
    first.close();

    // A fresh seed is untouched by the previous store's involuntary write.
    const second = await seedDemoStore("familia", AS_OF);
    const checking = (await second.assets.readAssets()).find(
      (a) => a.id === "asset_familia_checking",
    );
    expect(checking?.currentValue.amountMinor).not.toBe(99_999_00);
    second.close();
  }, 15_000);
});

describe("demo store cache (per process, #616)", () => {
  it("reuses the seeded workspace for the same persona + as-of date", async () => {
    const first = await getDemoStore("familia", "2026-06-10");
    await first.assets.updateAssetValuation("asset_familia_checking", 77_777_00);

    // Same key within the warm process ⇒ the SAME seeded store, mutation visible.
    const warm = await getDemoStore("familia", "2026-06-10");
    const checking = (await warm.assets.readAssets()).find(
      (a) => a.id === "asset_familia_checking",
    );
    expect(checking?.currentValue.amountMinor).toBe(77_777_00);
  }, 15_000);

  it("reseeds for a different as-of date or persona", async () => {
    const seeded = await getDemoStore("familia", "2026-06-11");
    await seeded.assets.updateAssetValuation("asset_familia_checking", 88_888_00);

    // A different day is a different key ⇒ a fresh, unmutated seed.
    const otherDay = await getDemoStore("familia", "2026-06-12");
    const checking = (await otherDay.assets.readAssets()).find(
      (a) => a.id === "asset_familia_checking",
    );
    expect(checking?.currentValue.amountMinor).not.toBe(88_888_00);

    // A different persona ⇒ a separately seeded workspace.
    const inversor = await getDemoStore("inversor", "2026-06-11");
    const inversorWorkspace = await inversor.workspace.readWorkspace();
    const familiaWorkspace = await seeded.workspace.readWorkspace();
    expect(inversorWorkspace?.members).not.toEqual(familiaWorkspace?.members);
  }, 20_000);
});
