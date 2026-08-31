import { describe, expect, test } from "vitest";
import { holdingFamily } from "./holding-family";

describe("holdingFamily (#1607)", () => {
  test("a liability is always the debt family — the debt model fans out inside it", () => {
    expect(holdingFamily({ kind: "liability" })).toBe("debt");
  });

  test("a Numista coin collection routes to its own family, not to the ledger one", () => {
    // It IS `derived` (ADR 0016), but its sub-detail is mirrored positions.
    expect(
      holdingFamily({ instrument: "coin_collection", kind: "asset", method: "derived" }),
    ).toBe("coin-collection");
  });

  test("the SOURCE outranks a wrong instrument column (#1691)", () => {
    // The row the v14 backfill left behind: a live Numista collection filed as
    // `other`, which derives `stored`. Routed by its instrument it landed on the
    // hand-valued ficha — no coin lens, and an instrument picker offering to
    // relabel the one holding nobody may relabel.
    expect(
      holdingFamily({
        connectedSourceAdapter: "numista",
        instrument: "other",
        kind: "asset",
        method: "stored",
      }),
    ).toBe("coin-collection");
  });

  test("a crypto holding with a Binance source routes to the mirrored-token family", () => {
    expect(
      holdingFamily({
        connectedSourceAdapter: "binance",
        instrument: "crypto",
        kind: "asset",
        method: "derived",
      }),
    ).toBe("binance");
  });

  test("a MANUAL crypto holding keeps its hand-written ledger", () => {
    // No source link: the same instrument, the opposite surface (#248).
    expect(
      holdingFamily({
        connectedSourceAdapter: null,
        instrument: "crypto",
        kind: "asset",
        method: "derived",
      }),
    ).toBe("investment");
  });

  test("a derived fund is the investment family", () => {
    expect(holdingFamily({ instrument: "fund", kind: "asset", method: "derived" })).toBe(
      "investment",
    );
  });

  test("an appreciating property is the housing family", () => {
    expect(
      holdingFamily({ instrument: "property", kind: "asset", method: "appreciating" }),
    ).toBe("housing");
  });

  test("everything else is the stored family — a value somebody sets", () => {
    expect(
      holdingFamily({ instrument: "current_account", kind: "asset", method: "stored" }),
    ).toBe("stored");
  });

  test("a coin collection wins over the method even if its method were to change", () => {
    // The instrument is the authority for the connected-source families: the
    // routing must not silently fall back to a ledger surface the holding has not
    // got, which is exactly what a method-first switch would do.
    expect(
      holdingFamily({ instrument: "coin_collection", kind: "asset", method: "stored" }),
    ).toBe("coin-collection");
  });
});
