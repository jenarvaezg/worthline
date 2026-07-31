import { describe, expect, it } from "vitest";

import {
  canHoldOffset,
  decideRestoreStep,
  isEditableTarget,
  isStaleRecord,
  isUserScrollKey,
  PAINT_WAIT_BUDGET_MS,
  parseSavedScroll,
  RECORD_TTL_MS,
  RESTORE_WINDOW_MS,
  type SavedScroll,
  shouldSaveScroll,
} from "./form-submit-scroll";

describe("isEditableTarget", () => {
  it.each(["input", "INPUT", "textarea", "select"])("treats <%s> as editable", (tag) => {
    expect(isEditableTarget({ tagName: tag, isContentEditable: false })).toBe(true);
  });

  it("treats a contenteditable host as editable", () => {
    expect(isEditableTarget({ tagName: "div", isContentEditable: true })).toBe(true);
  });

  it("treats ordinary elements and a missing target as not editable", () => {
    expect(isEditableTarget({ tagName: "div", isContentEditable: false })).toBe(false);
    expect(isEditableTarget({ tagName: null, isContentEditable: false })).toBe(false);
  });
});

describe("isUserScrollKey", () => {
  it.each([
    " ",
    "ArrowDown",
    "ArrowUp",
    "End",
    "Home",
    "PageDown",
    "PageUp",
  ])("counts %s outside a field as scrolling", (key) => {
    expect(isUserScrollKey({ key, targetIsEditable: false })).toBe(true);
  });

  it("does not count ordinary typing as scrolling", () => {
    expect(isUserScrollKey({ key: "a", targetIsEditable: false })).toBe(false);
    expect(isUserScrollKey({ key: "Tab", targetIsEditable: false })).toBe(false);
  });

  /**
   * The point of the editable guard (#1296): a validation error lands the person
   * back on the form, and arrowing through the field they just fixed must not
   * abandon the restoration.
   */
  it("does not count a scrolling key pressed inside a field", () => {
    expect(isUserScrollKey({ key: "ArrowDown", targetIsEditable: true })).toBe(false);
    expect(isUserScrollKey({ key: " ", targetIsEditable: true })).toBe(false);
  });
});

const target: SavedScroll = {
  pathname: "/patrimonio/anadir",
  x: 0,
  y: 863,
  savedAt: 1_000_000,
};

describe("isStaleRecord", () => {
  it("accepts the record the submit just wrote", () => {
    expect(isStaleRecord({ savedAt: 1_000, now: 1_050 })).toBe(false);
  });

  it("accepts a record right at the edge of the window", () => {
    expect(isStaleRecord({ savedAt: 1_000, now: 1_000 + RECORD_TTL_MS })).toBe(false);
  });

  it("rejects a record that outlived its navigation", () => {
    expect(isStaleRecord({ savedAt: 1_000, now: 1_001 + RECORD_TTL_MS })).toBe(true);
  });

  it("rejects a record from the future — that is a clock change, not a save", () => {
    expect(isStaleRecord({ savedAt: 5_000, now: 1_000 })).toBe(true);
  });
});

describe("shouldSaveScroll", () => {
  it("saves a real offset from a navigating form", () => {
    expect(shouldSaveScroll({ method: "post", scrollX: 0, scrollY: 863 })).toBe(true);
  });

  it("ignores a <dialog> submit, which never navigates", () => {
    expect(shouldSaveScroll({ method: "dialog", scrollX: 0, scrollY: 863 })).toBe(false);
    expect(shouldSaveScroll({ method: "DIALOG", scrollX: 0, scrollY: 863 })).toBe(false);
  });

  it("ignores a submit from the top of the page — nothing to restore", () => {
    expect(shouldSaveScroll({ method: "post", scrollX: 0, scrollY: 0 })).toBe(false);
  });

  it("saves a horizontal-only offset", () => {
    expect(shouldSaveScroll({ method: "post", scrollX: 120, scrollY: 0 })).toBe(true);
  });
});

describe("parseSavedScroll", () => {
  it("round-trips a well-formed record", () => {
    expect(parseSavedScroll(JSON.stringify(target))).toEqual(target);
  });

  it.each([
    ["nothing stored", null],
    ["empty string", ""],
    ["not JSON", "{oops"],
    ["missing pathname", JSON.stringify({ x: 0, y: 10, savedAt: 1 })],
    ["y is a string", JSON.stringify({ pathname: "/a", x: 0, y: "10", savedAt: 1 })],
    ["missing savedAt", JSON.stringify({ pathname: "/a", x: 0, y: 10 })],
  ])("returns null for %s", (_label, raw) => {
    expect(parseSavedScroll(raw)).toBeNull();
  });
});

describe("canHoldOffset", () => {
  it("is false while the document is collapsed mid-swap", () => {
    expect(canHoldOffset({ target, geometry: { scrollY: 55, maxScrollY: 55 } })).toBe(
      false,
    );
  });

  it("is true once the incoming route has painted", () => {
    expect(canHoldOffset({ target, geometry: { scrollY: 0, maxScrollY: 1200 } })).toBe(
      true,
    );
  });
});

describe("decideRestoreStep", () => {
  const painted = { scrollY: 0, maxScrollY: 1200 };
  /** Mid-swap: outgoing route display:none, incoming not painted yet. */
  const collapsed = { scrollY: 55, maxScrollY: 55 };
  const base = {
    target,
    geometry: painted,
    elapsedMs: 0,
    reachableElapsedMs: 0,
    interrupted: false,
  };

  it("applies the offset once the document can hold it", () => {
    expect(decideRestoreStep(base)).toEqual({ action: "apply", x: 0, y: 863 });
  });

  /**
   * The regression this module exists for (#1296). Writing here would be
   * clamped away, and the old implementation had already discarded the record.
   */
  it("waits instead of writing into a document too short to hold the offset", () => {
    expect(
      decideRestoreStep({ ...base, geometry: collapsed, reachableElapsedMs: null }),
    ).toEqual({ action: "wait" });
  });

  it("keeps watching while already on target — the router can still scroll to top", () => {
    expect(
      decideRestoreStep({ ...base, geometry: { scrollY: 863, maxScrollY: 1200 } }),
    ).toEqual({ action: "wait" });
  });

  it("re-applies when something scrolled us back to the top after we landed", () => {
    expect(decideRestoreStep({ ...base, reachableElapsedMs: 200 })).toEqual({
      action: "apply",
      x: 0,
      y: 863,
    });
  });

  it("tolerates sub-pixel drift without writing", () => {
    expect(
      decideRestoreStep({ ...base, geometry: { scrollY: 862, maxScrollY: 1200 } }),
    ).toEqual({ action: "wait" });
  });

  it("stops the moment it is interrupted — that intent outranks us", () => {
    expect(decideRestoreStep({ ...base, interrupted: true })).toEqual({
      action: "stop",
    });
  });

  it("stops on interruption even though the document is still short", () => {
    expect(
      decideRestoreStep({
        ...base,
        geometry: collapsed,
        reachableElapsedMs: null,
        interrupted: true,
      }),
    ).toEqual({ action: "stop" });
  });

  it("closes the re-assert window on its own clock", () => {
    expect(decideRestoreStep({ ...base, reachableElapsedMs: RESTORE_WINDOW_MS })).toEqual(
      { action: "stop" },
    );
  });

  /**
   * The point of splitting the two budgets (#1296): a slow route may not paint
   * for seconds on a loaded runner, and that wait must NOT eat the window we
   * use to re-assert against the router's scroll-to-top.
   */
  it("still restores after a paint far longer than the re-assert window", () => {
    expect(
      decideRestoreStep({
        ...base,
        elapsedMs: 6_000,
        reachableElapsedMs: 0,
      }),
    ).toEqual({ action: "apply", x: 0, y: 863 });
  });

  it("keeps waiting through a slow paint, without writing", () => {
    expect(
      decideRestoreStep({
        ...base,
        geometry: collapsed,
        elapsedMs: PAINT_WAIT_BUDGET_MS - 1,
        reachableElapsedMs: null,
      }),
    ).toEqual({ action: "wait" });
  });

  it("gives up when the paint budget runs out", () => {
    expect(
      decideRestoreStep({
        ...base,
        geometry: collapsed,
        elapsedMs: PAINT_WAIT_BUDGET_MS,
        reachableElapsedMs: null,
      }),
    ).toEqual({ action: "stop" });
  });

  it("honours explicit budget overrides", () => {
    expect(decideRestoreStep({ ...base, reachableElapsedMs: 60, windowMs: 50 })).toEqual({
      action: "stop",
    });
    expect(
      decideRestoreStep({
        ...base,
        geometry: collapsed,
        elapsedMs: 60,
        reachableElapsedMs: null,
        paintBudgetMs: 50,
      }),
    ).toEqual({ action: "stop" });
  });

  /**
   * A page that genuinely stays shorter must not be fought over forever — the
   * paint budget closes and we let it be.
   */
  it("gives up on a permanently shorter page instead of looping", () => {
    let elapsed = 0;
    let steps = 0;
    for (;;) {
      const step = decideRestoreStep({
        ...base,
        geometry: collapsed,
        elapsedMs: elapsed,
        reachableElapsedMs: null,
      });
      if (step.action === "stop") break;
      expect(step).toEqual({ action: "wait" });
      elapsed += 16;
      steps += 1;
      expect(steps).toBeLessThan(2000);
    }
    expect(elapsed).toBeGreaterThanOrEqual(PAINT_WAIT_BUDGET_MS);
  });
});
