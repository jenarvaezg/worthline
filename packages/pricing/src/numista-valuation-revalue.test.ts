/**
 * Coin valuation refresh (PRD #160 / #166, ADR 0017).
 *
 * The decoupled counterpart of the on-demand position sync: given the positions
 * already stored (with their indefinite coin detail), re-derive the two candidate
 * values from fresh inputs — metal spot (free, daily) recomputed every pass, the
 * numismatic estimate (Numista-capped) only refetched past its long TTL. Pure +
 * injected, so the cap discipline and outage behaviour are tested without I/O.
 */
import { describe, expect, it, vi } from "vitest";
import type { RevaluedPosition, RevaluePosition } from "./numista-valuation";
import { NUMISMATIC_TTL_DAYS, refreshCoinValuations } from "./numista-valuation";

const NOW = "2026-06-15T12:00:00.000Z";

/** A silver-eagle position whose detail (metal/fineness/weight) is already stored. */
function silverEagle(overrides: Partial<RevaluePosition> = {}): RevaluePosition {
  return {
    id: "pos-eagle",
    typeId: 1493,
    issueId: 32723,
    grade: "unc",
    quantity: 1,
    metal: "silver",
    finenessMillis: 999,
    weightGrams: 31.103,
    metalValueMinor: 1, // stale prior value, must be overwritten
    numismaticValueMinor: 7558,
    numismaticFetchedAt: NOW, // fresh → numismatic not refetched this pass
    ...overrides,
  };
}

function deps(overrides: Partial<Parameters<typeof refreshCoinValuations>[1]> = {}) {
  return {
    prices: vi.fn(async () => ({
      currency: "EUR",
      prices: [{ grade: "unc", price: 75.585 }],
    })),
    spotPerOzEur: vi.fn(async () => 28),
    ...overrides,
  };
}

describe("refreshCoinValuations — metal value rides the daily spot", () => {
  it("recomputes metal value from stored detail × fresh spot", async () => {
    const { updates } = await refreshCoinValuations([silverEagle()], deps(), {
      nowIso: NOW,
    });

    expect(updates).toHaveLength(1);
    // 31.103g × .999 / 31.1035 × €28 → 2797 minor (same basis as the sync path)
    expect(updates[0]).toMatchObject({ id: "pos-eagle", metalValueMinor: 2797 });
  });

  it("keeps the last-known metal value when spot is unavailable (outage)", async () => {
    const { updates } = await refreshCoinValuations(
      [silverEagle({ metalValueMinor: 2750 })],
      deps({ spotPerOzEur: vi.fn(async () => null) }),
      { nowIso: NOW },
    );

    // Outage leaves values untouched → nothing to persist this pass.
    expect(updates).toEqual([]);
  });

  it("dedupes the spot lookup across positions of the same metal", async () => {
    const d = deps();
    await refreshCoinValuations([silverEagle({ id: "a" }), silverEagle({ id: "b" })], d, {
      nowIso: NOW,
    });

    expect(d.spotPerOzEur).toHaveBeenCalledTimes(1); // silver spot fetched once
  });

  it("omits coins whose metal and numismatic values are unchanged", async () => {
    const { updates } = await refreshCoinValuations(
      [
        silverEagle({
          metalValueMinor: 2797,
          numismaticFetchedAt: NOW,
          numismaticValueMinor: 7558,
        }),
      ],
      deps(),
      { nowIso: NOW },
    );

    expect(updates).toEqual([]);
  });
});

describe("refreshCoinValuations — numismatic estimate rides the long TTL", () => {
  const STALE = "2026-05-01T12:00:00.000Z"; // 45 days before NOW → past the 30d TTL

  it("refetches and restamps when the estimate is past its long TTL", async () => {
    const d = deps();
    const { updates } = await refreshCoinValuations(
      [silverEagle({ numismaticFetchedAt: STALE, numismaticValueMinor: 1 })],
      d,
      { nowIso: NOW },
    );

    expect(d.prices).toHaveBeenCalledWith(1493, 32723);
    expect(updates[0]).toMatchObject({
      numismaticValueMinor: 7558, // 75.585 → 7558 minor, × qty 1
      numismaticFetchedAt: NOW,
    });
  });

  it("refetches when never fetched before (fetched-at null)", async () => {
    const d = deps();
    await refreshCoinValuations([silverEagle({ numismaticFetchedAt: null })], d, {
      nowIso: NOW,
    });

    expect(d.prices).toHaveBeenCalledTimes(1);
  });

  it("skips the refetch (no Numista call) while the estimate is still fresh", async () => {
    const d = deps();
    const { updates } = await refreshCoinValuations(
      [silverEagle({ numismaticFetchedAt: NOW, numismaticValueMinor: 9999 })],
      d,
      { nowIso: NOW },
    );

    expect(d.prices).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({
      numismaticValueMinor: 9999, // last-known, untouched
      numismaticFetchedAt: NOW,
    });
  });

  it("keeps last-known numismatic and leaves fetched-at when the fetch fails", async () => {
    const { updates } = await refreshCoinValuations(
      [silverEagle({ numismaticFetchedAt: STALE, numismaticValueMinor: 7558 })],
      deps({ prices: vi.fn(async () => null) }), // Numista outage / unavailable
      { nowIso: NOW },
    );

    // Value survives; fetched-at is NOT advanced, so the next pass retries.
    expect(updates[0]).toMatchObject({
      numismaticValueMinor: 7558,
      numismaticFetchedAt: STALE,
    });
  });

  it("clears the estimate (stamping now) when the fetch succeeds but has no grade", async () => {
    const { updates } = await refreshCoinValuations(
      [
        silverEagle({
          grade: "ms70",
          numismaticFetchedAt: STALE,
          numismaticValueMinor: 7558,
        }),
      ],
      deps(), // prices return only an "unc" grade → no match for "ms70"
      { nowIso: NOW },
    );

    // A successful read that finds no estimate at the grade is authoritative:
    // value becomes null (no fabrication) and fetched-at advances.
    expect(updates[0]).toMatchObject({
      numismaticValueMinor: null,
      numismaticFetchedAt: NOW,
    });
  });

  it("dedupes the prices lookup across positions sharing (type, issue)", async () => {
    const d = deps();
    await refreshCoinValuations(
      [
        silverEagle({ id: "a", numismaticFetchedAt: STALE }),
        silverEagle({ id: "b", numismaticFetchedAt: STALE }),
      ],
      d,
      { nowIso: NOW },
    );

    expect(d.prices).toHaveBeenCalledTimes(1); // same (type, issue) → one estimate fetch
  });
});

/**
 * A pass that dies mid-collection (#1739). The updates it already resolved are the
 * coins it ALREADY paid Numista for; losing them makes the retry buy the whole
 * collection again — the bug this pins.
 */
describe("refreshCoinValuations — a pass cut short keeps what it already paid for", () => {
  const STALE = "2026-05-01T12:00:00.000Z"; // 45 days before NOW → past the 30d TTL

  /** Three coins past their TTL, each on its own issue → one estimate call each. */
  function trio(): RevaluePosition[] {
    return [1, 2, 3].map((n) =>
      silverEagle({
        id: `pos-${n}`,
        issueId: 32720 + n,
        numismaticFetchedAt: STALE,
        numismaticValueMinor: 1,
      }),
    );
  }

  /** Numista answers every issue but `failOn`, where it goes down mid-pass. */
  function pricesFailingOn(failOn: number) {
    return vi.fn(async (_typeId: number, issueId: number) => {
      if (issueId === failOn) {
        throw new Error("Numista 500");
      }
      return { currency: "EUR", prices: [{ grade: "unc", price: 75.585 }] };
    });
  }

  /** What the store does with a pass's updates — the next pass's starting point. */
  function withUpdates(
    positions: RevaluePosition[],
    updates: RevaluedPosition[],
  ): RevaluePosition[] {
    const byId = new Map(updates.map((update) => [update.id, update]));
    return positions.map((position) => {
      const update = byId.get(position.id);
      return update ? { ...position, ...update } : position;
    });
  }

  it("returns the coins resolved before the failure, plus the error that cut it short", async () => {
    const outcome = await refreshCoinValuations(
      trio(),
      deps({ prices: pricesFailingOn(32723) }),
      { nowIso: NOW },
    );

    expect(outcome.error?.message).toBe("Numista 500");
    // The two coins bought before the outage survive, stamped fresh.
    expect(outcome.updates.map((update) => update.id)).toEqual(["pos-1", "pos-2"]);
    expect(outcome.updates.map((update) => update.numismaticFetchedAt)).toEqual([
      NOW,
      NOW,
    ]);
  });

  it("charges the second pass only for the coins the first never reached", async () => {
    const positions = trio();

    const first = await refreshCoinValuations(
      positions,
      deps({ prices: pricesFailingOn(32723) }),
      { nowIso: NOW },
    );

    // The store applied what the failed pass had in hand; the source stays stale,
    // so the retry runs immediately with those stamps in place.
    const retryDeps = deps();
    const second = await refreshCoinValuations(
      withUpdates(positions, first.updates),
      retryDeps,
      {
        nowIso: NOW,
      },
    );

    expect(retryDeps.prices).toHaveBeenCalledTimes(1);
    expect(retryDeps.prices).toHaveBeenCalledWith(1493, 32723);
    expect(second.error).toBeNull();
    expect(second.updates.map((update) => update.id)).toEqual(["pos-3"]);
  });

  it("banks a tranche every `every` coins, so a death with no exception keeps them", async () => {
    // The pass that ate 440 calls never threw: ~80 sequential fetches outlived the
    // process. Nothing catches that — the only defence is having already written.
    const banked: string[][] = [];
    const outcome = await refreshCoinValuations(trio(), deps(), {
      checkpoint: {
        every: 2,
        persist: async (updates) => {
          banked.push(updates.map((update) => update.id));
        },
      },
      nowIso: NOW,
    });

    // Two coins banked mid-pass; the third rides the final write, and the outcome
    // still carries all three (re-applying a coin's own values is a no-op).
    expect(banked).toEqual([["pos-1", "pos-2"]]);
    expect(outcome.updates.map((update) => update.id)).toEqual([
      "pos-1",
      "pos-2",
      "pos-3",
    ]);
  });

  it("keeps a banked tranche when the pass then fails", async () => {
    const banked: string[][] = [];
    const outcome = await refreshCoinValuations(
      trio(),
      deps({ prices: pricesFailingOn(32723) }),
      {
        checkpoint: {
          every: 2,
          persist: async (updates) => {
            banked.push(updates.map((update) => update.id));
          },
        },
        nowIso: NOW,
      },
    );

    expect(banked).toEqual([["pos-1", "pos-2"]]);
    expect(outcome.error?.message).toBe("Numista 500");
  });

  it("fails the pass — keeping its work — when a tranche write fails", async () => {
    const outcome = await refreshCoinValuations(trio(), deps(), {
      checkpoint: {
        every: 1,
        persist: async () => {
          throw new Error("write failed");
        },
      },
      nowIso: NOW,
    });

    expect(outcome.error?.message).toBe("write failed");
    expect(outcome.updates.map((update) => update.id)).toEqual(["pos-1"]);
  });

  it("reports no error and every coin when the pass runs to completion", async () => {
    const outcome = await refreshCoinValuations(trio(), deps(), { nowIso: NOW });

    expect(outcome.error).toBeNull();
    expect(outcome.updates).toHaveLength(3);
  });
});

describe("NUMISMATIC_TTL_DAYS", () => {
  it("is a long TTL (30 days) per ADR 0017", () => {
    expect(NUMISMATIC_TTL_DAYS).toBe(30);
  });
});
