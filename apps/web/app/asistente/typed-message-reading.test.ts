import { describe, expect, it } from "vitest";

import {
  dateInMessage,
  dateTokenIn,
  dayBefore,
  joinRefusalGaps,
} from "./typed-message-reading";

const TODAY = "2026-08-30";

describe("dateTokenIn", () => {
  it("reads both printed shapes and cuts the token out of the text", () => {
    expect(dateTokenIn("saldo 2026-08-12 de 1.000")).toEqual({
      day: "2026-08-12",
      rest: "saldo  de 1.000",
    });
    expect(dateTokenIn("el 12/08/2026 traspasé 500")).toEqual({
      day: "2026-08-12",
      rest: "el  traspasé 500",
    });
  });

  /**
   * The distinction the three readers depend on (#1395): date-SHAPED but not a day is
   * `day: null`, never «no date». Each lane decides what to do about it, but none of
   * them may carry on as if nothing was written.
   */
  it("separates «no date» from «a date I read wrong»", () => {
    expect(dateTokenIn("compré 6 part. por 312,55 €")).toBeNull();
    expect(dateTokenIn("el 30/02/2026 compré")).toEqual({
      day: null,
      rest: "el  compré",
    });
  });

  /** The fence that keeps a phone number from being read as a day. */
  it("does not read a date out of a longer run of digits", () => {
    expect(dateTokenIn("llámame al 600.12.3456")).toBeNull();
  });
});

describe("dateInMessage", () => {
  it("resolves the two relative days a message may name, against its clock", () => {
    expect(dateInMessage("he comprado hoy 6 part.", TODAY)?.day).toBe(TODAY);
    expect(dateInMessage("ayer vendí 3 part.", TODAY)?.day).toBe("2026-08-29");
    expect(dateInMessage("he comprado ahora 6 part.", TODAY)?.day).toBe(TODAY);
  });

  it("returns null when nothing names a day: silence is never today", () => {
    expect(dateInMessage("he comprado 6 part. por 312,55 €", TODAY)).toBeNull();
  });

  it("crosses a month boundary through UTC, where no timezone can shift it", () => {
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
    expect(dayBefore("2026-01-01")).toBe("2025-12-31");
  });
});

describe("joinRefusalGaps", () => {
  it("says every gap in one sentence", () => {
    expect(joinRefusalGaps(["falta A", "falta B", "falta C"], "x")).toBe(
      "falta A; falta B; y falta C",
    );
    expect(joinRefusalGaps(["falta A"], "x")).toBe("falta A");
    expect(joinRefusalGaps([], "el hueco de siempre")).toBe("el hueco de siempre");
  });
});
