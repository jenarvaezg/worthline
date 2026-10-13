import { describe, expect, it } from "vitest";

import { stripOverflow } from "./nav-strip-edges";

describe("stripOverflow", () => {
  it("is none when the content fits the strip", () => {
    expect(stripOverflow({ scrollLeft: 0, scrollWidth: 357, clientWidth: 366 })).toBe(
      "none",
    );
  });

  it("is none when the content is only 1px wider (subpixel rounding)", () => {
    expect(stripOverflow({ scrollLeft: 0, scrollWidth: 367, clientWidth: 366 })).toBe(
      "none",
    );
  });

  it("is end when the strip overflows and sits at its start", () => {
    // 390 px with a session: 450 px of content in a 366 px strip (#1723).
    expect(stripOverflow({ scrollLeft: 0, scrollWidth: 450, clientWidth: 366 })).toBe(
      "end",
    );
  });

  it("is both when the strip is scrolled halfway", () => {
    expect(stripOverflow({ scrollLeft: 42, scrollWidth: 450, clientWidth: 366 })).toBe(
      "both",
    );
  });

  it("is start at the end even with a 0.5px remainder", () => {
    expect(stripOverflow({ scrollLeft: 83.5, scrollWidth: 450, clientWidth: 366 })).toBe(
      "start",
    );
  });
});
