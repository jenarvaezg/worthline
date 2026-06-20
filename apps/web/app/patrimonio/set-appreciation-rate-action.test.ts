/**
 * setAppreciationRateAction ripple-range coverage (#184).
 *
 * A rate change must recalculate EVERY snapshot the appreciation rate values —
 * including ones dated BEFORE the first market appraisal, where the housing curve
 * compounds the rate backward (CONTEXT.md: "extrapolate where no market appraisal
 * exists — before the first appraisal or after the last"). The action used to
 * ripple only from the first anchor's date, so a pre-appraisal snapshot kept its
 * stale value. The fix moves the earliest-affected-date derivation (ADR 0020)
 * behind the seam: `setAnnualAppreciationRateAndRipple` computes
 * min(first anchor, earliest snapshot) internally so the whole rate-valued range
 * recomputes. The negative case asserts a snapshot pinned by an interpolating
 * appraisal segment is left untouched (the rate does not value it).
 */
import { createInMemoryStore } from "@worthline/db";
import type { WorthlineStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import { setAppreciationRateAction } from "./actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

/** Invoke the action (which always throws redirect()) and return the digest. */
async function runAction(fd: FormData, store: WorthlineStore): Promise<string> {
  try {
    await setAppreciationRateAction(fd, store);
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
    id: "piso",
    liquidityTier: "illiquid",
    name: "Piso",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "real_estate",
  });
  return store;
}

async function grossAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey)
    ?.grossAssets.amountMinor;
}

async function addMarketAnchor(
  store: WorthlineStore,
  anchorId: string,
  valuationDate: string,
  valueMinor: number,
): Promise<void> {
  await store.addValuationAnchorAndRipple(
    {
      adjustsPriorCurve: true,
      assetId: "piso",
      id: anchorId,
      valuationDate,
      valueMinor,
    },
    { today: "2026-06-14" },
  );
}

describe("setAppreciationRateAction — ripple range (#184)", () => {
  test("a rate change recalculates a snapshot dated before the first market appraisal", async () => {
    const store = await seed();
    await store.assets.setAnnualAppreciationRate("piso", "0.03");

    // Two appraisals (2024 + 2025) generate snapshots at both dates.
    await addMarketAnchor(store, "a0", "2024-01-01", 100_000_00);
    await addMarketAnchor(store, "a1", "2025-01-01", 120_000_00);

    // Drop the 2024 appraisal: now the ONLY appraisal is 2025-01-01, so the
    // 2024-01-01 snapshot sits BEFORE the first appraisal and is valued by the
    // rate compounded backward — yet its snapshot already exists and survives.
    await store.deleteValuationAnchorAndRipple("a0", { today: "2026-06-14" });

    const before = await grossAt(store, "2024-01-01");
    expect(before).toBeDefined();

    await runAction(form({ id: "piso", rate: "10" }), store);
    // The pre-appraisal snapshot must reflect the new rate (10% back-extrapolated
    // from the 2025 appraisal is well below the old 3% value).
    const after = await grossAt(store, "2024-01-01");
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    store.close();
  });

  test("a snapshot pinned by an interpolating appraisal segment is NOT changed by a rate edit", async () => {
    const store = await seed();
    await store.assets.setAnnualAppreciationRate("piso", "0.03");

    // Two appraisals bracket a mid snapshot; between them linear interpolation
    // (not the rate) values the curve, so the mid snapshot is rate-invariant.
    await addMarketAnchor(store, "a0", "2024-01-01", 100_000_00);
    await addMarketAnchor(store, "a1", "2025-01-01", 120_000_00);
    await addMarketAnchor(store, "mid", "2024-07-01", 110_000_00);

    const before = await grossAt(store, "2024-07-01");
    expect(before).toBe(110_000_00);

    await runAction(form({ id: "piso", rate: "10" }), store);
    // The interpolated segment ignores the rate — its snapshot is untouched.
    expect(await grossAt(store, "2024-07-01")).toBe(before);
    store.close();
  });
});
