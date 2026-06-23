import { describe, expect, test } from "vitest";

import {
  FRAMING_VIEW_PARAM,
  RANGE_VIEW_PARAM,
  readViewParam,
  writeViewParam,
  type ViewParamSpec,
} from "./view-state";

/**
 * The S2 foundation (#518, ADR 0036 / interaction-patterns §3): the pure URL ⇄
 * view-state mirror an island uses to read its value on load and compute the
 * next query string for `history.pushState` on toggle — no server round-trip.
 * Reused by S3 (range/density) and S4 (drill), so the contract is exercised
 * both via the concrete framing spec and a synthetic multi-value spec.
 */

const RANGE: ViewParamSpec<"1y" | "3y" | "all"> = {
  key: "range",
  allowed: ["1y", "3y", "all"],
  fallback: "all",
};

describe("readViewParam", () => {
  test("reads the spec's value from the query string", () => {
    expect(readViewParam("?view=liquid", FRAMING_VIEW_PARAM)).toBe("liquid");
  });

  test("falls back to the default when the key is absent", () => {
    expect(readViewParam("?range=1y", FRAMING_VIEW_PARAM)).toBe("total");
  });

  test("falls back when the value is not an allowed one", () => {
    expect(readViewParam("?view=bogus", FRAMING_VIEW_PARAM)).toBe("total");
  });

  test("tolerates a search string with or without the leading '?'", () => {
    expect(readViewParam("view=liquid", FRAMING_VIEW_PARAM)).toBe("liquid");
    expect(readViewParam("", FRAMING_VIEW_PARAM)).toBe("total");
  });

  test("reads its key while other params are present", () => {
    expect(readViewParam("?range=1y&view=liquid&drill=liquid", FRAMING_VIEW_PARAM)).toBe(
      "liquid",
    );
    expect(readViewParam("?range=3y", RANGE)).toBe("3y");
  });
});

describe("writeViewParam", () => {
  test("sets a non-default value, yielding a leading-'?' query string", () => {
    expect(writeViewParam("", FRAMING_VIEW_PARAM, "liquid")).toBe("?view=liquid");
  });

  test("OMITS the key when the value is the default (clean URL)", () => {
    expect(writeViewParam("?view=liquid", FRAMING_VIEW_PARAM, "total")).toBe("");
  });

  test("preserves every other param when setting its key", () => {
    expect(writeViewParam("?range=1y&drill=liquid", FRAMING_VIEW_PARAM, "liquid")).toBe(
      "?range=1y&drill=liquid&view=liquid",
    );
  });

  test("preserves every other param when omitting its key on default", () => {
    expect(
      writeViewParam("?view=liquid&range=1y&drill=liquid", FRAMING_VIEW_PARAM, "total"),
    ).toBe("?range=1y&drill=liquid");
  });

  test("replaces an existing value of its key rather than appending", () => {
    expect(writeViewParam("?view=liquid", FRAMING_VIEW_PARAM, "liquid")).toBe(
      "?view=liquid",
    );
    expect(writeViewParam("?range=1y", RANGE, "3y")).toBe("?range=3y");
  });

  test("a round-trip back to the default reproduces the clean URL", () => {
    const dirty = writeViewParam("?range=1y", FRAMING_VIEW_PARAM, "liquid");
    expect(dirty).toBe("?range=1y&view=liquid");
    expect(writeViewParam(dirty, FRAMING_VIEW_PARAM, "total")).toBe("?range=1y");
  });
});

describe("FRAMING_VIEW_PARAM", () => {
  test("models the Vista toggle: net worth (default) ↔ liquid", () => {
    expect(FRAMING_VIEW_PARAM.key).toBe("view");
    expect(FRAMING_VIEW_PARAM.fallback).toBe("total");
    expect([...FRAMING_VIEW_PARAM.allowed]).toEqual(["total", "liquid"]);
  });
});

describe("RANGE_VIEW_PARAM", () => {
  test("models the composition range pills: 1A/3A/5A with the clean default 'all'", () => {
    expect(RANGE_VIEW_PARAM.key).toBe("range");
    // Mirrors `parseRangeParam`/`compositionUrl`: `all` is the omitted default.
    expect(RANGE_VIEW_PARAM.fallback).toBe("all");
    expect([...RANGE_VIEW_PARAM.allowed]).toEqual(["1y", "3y", "5y", "all"]);
  });

  test("reads/writes the range key like any spec, omitting the default", () => {
    expect(readViewParam("?range=3y&view=liquid", RANGE_VIEW_PARAM)).toBe("3y");
    expect(readViewParam("?view=liquid", RANGE_VIEW_PARAM)).toBe("all");
    expect(writeViewParam("?view=liquid", RANGE_VIEW_PARAM, "1y")).toBe(
      "?view=liquid&range=1y",
    );
    expect(writeViewParam("?view=liquid&range=1y", RANGE_VIEW_PARAM, "all")).toBe(
      "?view=liquid",
    );
  });
});
