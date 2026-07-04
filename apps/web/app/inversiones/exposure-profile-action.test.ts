/**
 * Integration test for the exposure-profile hand-entry action (PRD #539 S1,
 * #541) via the `_store` injection seam, plus the round-trip through the domain
 * look-through. Proves: a representative FormData → profile → save → read back;
 * that a holding of that key fed through `lookThroughExposure` reflects the
 * entered geography; and that a pension plan with no ISIN keys by providerSymbol.
 * Prior art: inversiones/statement-actions.test.ts.
 */

import { createInMemoryStore } from "@worthline/db";
import type { WorthlineStore } from "@worthline/db";
import { lookThroughExposure } from "@worthline/domain";
import type { ExposureLookthroughHolding, ExposureProfile } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { saveExposureProfileAction } from "./actions";

/** A fund with an ISIN — the common hand-enterable case. */
async function seedFund(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    isin: "IE00B4L5Y983",
    liquidityTier: "market",
    name: "iShares MSCI World",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    providerSymbol: "SWDA",
  });
}

/** A pension plan carrying a provider symbol but NO ISIN. */
async function seedPensionPlan(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "plan",
    liquidityTier: "illiquid",
    name: "Plan de pensiones indexado",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    providerSymbol: "INDEXA-PP",
  });
}

function exposureForm(over: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("currentUrl", "/patrimonio/fund/editar");
  fd.set("geo_us", "70");
  fd.set("geo_europe_developed", "20");
  fd.set("assetClass", "equity");
  fd.set("ter", "0,20");
  fd.set("trackedIndex", "MSCI World");
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}

/** Run the action and return its NEXT_REDIRECT digest (the redirect URL). */
async function run(
  fd: FormData,
  store: WorthlineStore,
  assetId = "fund",
): Promise<string> {
  try {
    await saveExposureProfileAction(assetId, fd, store);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

describe("saveExposureProfileAction", () => {
  test("parses the form, saves the canonical row, and reads it back by ISIN key", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const digest = await run(exposureForm(), store);
    expect(digest).toContain("ok=exposure_profile_saved");

    const saved = await store.exposureProfiles.readExposureProfile("IE00B4L5Y983");
    expect(saved).not.toBeNull();
    expect(saved!.breakdowns.geography).toEqual({ us: "0.7", europe_developed: "0.2" });
    expect(saved!.breakdowns.assetClass).toEqual({ equity: "1" });
    expect(saved!.ter).toBe("0.002");
    expect(saved!.trackedIndex).toBe("MSCI World");
  });

  test("the saved profile drives look-through geography for a holding of that key", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);
    await run(exposureForm(), store);

    const saved = await store.exposureProfiles.readExposureProfile("IE00B4L5Y983");
    const profiles = new Map<string, ExposureProfile>([["IE00B4L5Y983", saved!]]);
    const holding: ExposureLookthroughHolding = {
      id: "fund",
      valueMinor: 100_00,
      currency: "EUR",
      instrument: "etf",
      isin: "IE00B4L5Y983",
    };

    const result = lookThroughExposure({
      baseCurrency: "EUR",
      grossAssets: { amountMinor: 100_00, currency: "EUR" },
      holdings: [holding],
      profiles,
    });

    const us = result.geography.slices.find((s) => s.key === "us");
    expect(us).toBeDefined();
    expect(us!.weight).toBe("0.7");
    expect(us!.value.amountMinor).toBe(70_00);
  });

  test("a pension plan with no ISIN is keyed by providerSymbol", async () => {
    const store = await createInMemoryStore();
    await seedPensionPlan(store);

    const fd = exposureForm();
    fd.set("currentUrl", "/patrimonio/plan/editar");
    const digest = await run(fd, store, "plan");
    expect(digest).toContain("ok=exposure_profile_saved");

    expect(await store.exposureProfiles.readExposureProfile("IE00B4L5Y983")).toBeNull();
    const bySymbol = await store.exposureProfiles.readExposureProfile("INDEXA-PP");
    expect(bySymbol).not.toBeNull();
    expect(bySymbol!.breakdowns.geography).toEqual({
      us: "0.7",
      europe_developed: "0.2",
    });
  });

  test("blank form fields clear previously saved optional profile fields", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);
    await run(exposureForm(), store);

    const digest = await run(
      exposureForm({
        assetClass: "",
        geo_europe_developed: "",
        geo_us: "",
        hedged: "on",
        ter: "",
        trackedIndex: "",
      }),
      store,
    );

    expect(digest).toContain("ok=exposure_profile_saved");
    const saved = await store.exposureProfiles.readExposureProfile("IE00B4L5Y983");
    expect(saved).toMatchObject({
      hedged: true,
      ter: null,
      trackedIndex: null,
    });
    expect(saved!.breakdowns.geography).toEqual({});
    expect(saved!.breakdowns.assetClass).toEqual({});
  });

  test("an over-100% geography vector is rejected with the Spanish error, nothing saved", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const digest = await run(
      exposureForm({ geo_us: "80", geo_europe_developed: "40" }),
      store,
    );
    expect(digest).toContain("error=");
    expect(decodeURIComponent(digest)).toMatch(/100%/);
    expect(await store.exposureProfiles.readExposureProfile("IE00B4L5Y983")).toBeNull();
  });

  test("the Vaciar button (clear=1) deletes the stored row", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);
    await run(exposureForm(), store);
    expect(
      await store.exposureProfiles.readExposureProfile("IE00B4L5Y983"),
    ).not.toBeNull();

    const digest = await run(exposureForm({ clear: "1" }), store);
    expect(digest).toContain("ok=exposure_profile_cleared");
    expect(await store.exposureProfiles.readExposureProfile("IE00B4L5Y983")).toBeNull();
  });
});
