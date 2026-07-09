/**
 * setHousingValuationCadenceAction tests (ADR 0031, #394). Asserts the action
 * persists a cadence change through the housing seam in a live request, rejects a
 * non-housing target and an invalid value, and is short-circuited (the store left
 * untouched) in the read-only demo. Mirrors the set-valuation-cadence (debt) and
 * set-appreciation-rate action test shape.
 */

import type { WorthlineStore } from "@worthline/db";

import { createInMemoryStore } from "@worthline/db";
import { type Clock, fixedClock } from "@worthline/domain";
import { afterEach, describe, expect, test, vi } from "vitest";

import { setHousingValuationCadenceAction } from "./actions";

// Drive demo-ness through the persona cookie the store seam reads.
let mockPersonaCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "wl_demo_persona" && mockPersonaCookie
        ? { value: mockPersonaCookie }
        : undefined,
  }),
}));

afterEach(() => {
  mockPersonaCookie = undefined;
});

const TODAY = "2026-06-15";
const CLOCK = fixedClock(TODAY);

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

/** Invoke the action (which always throws redirect()) and return the digest. */
async function runAction(
  fd: FormData,
  store: WorthlineStore,
  clock: Clock = CLOCK,
): Promise<string> {
  try {
    await setHousingValuationCadenceAction(fd, store, clock);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

async function seed(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 130_000_00,
    id: "home",
    isPrimaryResidence: true,
    liquidityTier: "illiquid",
    name: "Casa",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "real_estate",
  });
  return store;
}

describe("setHousingValuationCadenceAction", () => {
  test("persists a cadence change in a live request", async () => {
    const store = await seed();

    const digest = await runAction(
      form({ id: "home", cadence: "interpolated", currentUrl: "/patrimonio" }),
      store,
    );
    expect(decodeURIComponent(digest.replace(/\+/g, " "))).toContain(
      "valuation_cadence_saved",
    );
    expect(await store.assets.readValuationCadence("home")).toBe("interpolated");
    store.close();
  });

  test("rejects an invalid cadence value", async () => {
    const store = await seed();

    const digest = await runAction(
      form({ id: "home", cadence: "nonsense", currentUrl: "/patrimonio" }),
      store,
    );
    expect(decodeURIComponent(digest.replace(/\+/g, " "))).toContain("error");
    // Unchanged — the parse failed before any store write.
    expect(await store.assets.readValuationCadence("home")).toBeNull();
    store.close();
  });

  test("rejects a non-housing asset", async () => {
    const store = await seed();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });

    const digest = await runAction(
      form({ id: "cash", cadence: "interpolated", currentUrl: "/patrimonio" }),
      store,
    );
    expect(decodeURIComponent(digest.replace(/\+/g, " "))).toContain("error");
    expect(await store.assets.readValuationCadence("cash")).toBeNull();
    store.close();
  });

  test("is blocked in demo mode and leaves the store untouched", async () => {
    const store = await seed();
    mockPersonaCookie = "familia";

    const digest = await runAction(
      form({ id: "home", cadence: "interpolated", currentUrl: "/patrimonio" }),
      store,
    );
    expect(decodeURIComponent(digest.replace(/\+/g, " "))).toContain(
      "deshabilitada en la demo",
    );
    // The guard short-circuited before the store — cadence stays unset.
    expect(await store.assets.readValuationCadence("home")).toBeNull();
    store.close();
  });
});
