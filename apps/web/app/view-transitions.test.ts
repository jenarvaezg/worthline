import { describe, expect, test } from "vitest";

import {
  classifyTransition,
  supportsViewTransitions,
  type TransitionClassification,
} from "./view-transitions";

/**
 * Unit tests for the pure transition-eligibility module (#517,
 * interaction-patterns §5, §7).  Mirrors the style of `view-state.test.ts` —
 * no DOM, no jsdom, pure node environment.
 */

describe("classifyTransition", () => {
  // ── Same pathname → not eligible ──────────────────────────────────────────

  test("same pathname is not eligible", () => {
    const result = classifyTransition("/", "/");
    expect(result.eligible).toBe(false);
    expect(result.transitionTypes).toEqual([]);
  });

  test("same sub-path is not eligible", () => {
    const result = classifyTransition("/patrimonio/abc/editar", "/patrimonio/abc/editar");
    expect(result.eligible).toBe(false);
  });

  // ── Top-level section navigation → directional slide ─────────────────────

  test("/ → /patrimonio is a forward slide (index 0 → 1)", () => {
    const result: TransitionClassification = classifyTransition("/", "/patrimonio");
    expect(result.eligible).toBe(true);
    expect(result.transitionTypes).toEqual(["slide-forward"]);
  });

  test("/ → /historico is a forward slide (index 0 → 2)", () => {
    expect(classifyTransition("/", "/historico").transitionTypes).toEqual([
      "slide-forward",
    ]);
  });

  test("/ → /ajustes is a forward slide (index 0 → 3)", () => {
    expect(classifyTransition("/", "/ajustes").transitionTypes).toEqual([
      "slide-forward",
    ]);
  });

  test("/historico → / is a backward slide (index 2 → 0)", () => {
    const result = classifyTransition("/historico", "/");
    expect(result.eligible).toBe(true);
    expect(result.transitionTypes).toEqual(["slide-back"]);
  });

  test("/ajustes → /patrimonio is a backward slide (index 3 → 1)", () => {
    expect(classifyTransition("/ajustes", "/patrimonio").transitionTypes).toEqual([
      "slide-back",
    ]);
  });

  test("/patrimonio → /historico is a forward slide (index 1 → 2)", () => {
    expect(classifyTransition("/patrimonio", "/historico").transitionTypes).toEqual([
      "slide-forward",
    ]);
  });

  // ── Sub-paths inherit their section's nav-order index ─────────────────────

  test("sub-path of /patrimonio treated as /patrimonio for direction", () => {
    const result = classifyTransition("/patrimonio/abc/editar", "/historico");
    expect(result.eligible).toBe(true);
    expect(result.transitionTypes).toEqual(["slide-forward"]);
  });

  test("/ → /patrimonio/abc sub-path is a forward slide", () => {
    expect(classifyTransition("/", "/patrimonio/abc").transitionTypes).toEqual([
      "slide-forward",
    ]);
  });

  test("deep /ajustes sub-path → / is a backward slide", () => {
    expect(classifyTransition("/ajustes/conectar/numista", "/").transitionTypes).toEqual([
      "slide-back",
    ]);
  });

  // ── Cross-surface navigation → cross-fade ─────────────────────────────────

  test("unknown path → top section yields cross-fade", () => {
    const result = classifyTransition("/api/unknown", "/");
    expect(result.eligible).toBe(true);
    expect(result.transitionTypes).toEqual(["cross-fade"]);
  });

  test("top section → unknown path yields cross-fade", () => {
    const result = classifyTransition("/", "/some-other-page");
    expect(result.eligible).toBe(true);
    expect(result.transitionTypes).toEqual(["cross-fade"]);
  });

  test("two unknown paths yield cross-fade", () => {
    const result = classifyTransition("/foo", "/bar");
    expect(result.eligible).toBe(true);
    expect(result.transitionTypes).toEqual(["cross-fade"]);
  });

  // ── Eligible flag matches the presence of transitionTypes ─────────────────

  test("eligible navigations always carry at least one transitionType", () => {
    const cases = [
      classifyTransition("/", "/patrimonio"),
      classifyTransition("/historico", "/"),
      classifyTransition("/", "/some-page"),
    ];
    for (const result of cases) {
      expect(result.eligible).toBe(true);
      expect(result.transitionTypes.length).toBeGreaterThan(0);
    }
  });
});

describe("supportsViewTransitions", () => {
  test("returns false in the node test environment (no document)", () => {
    // The node environment has no `document`, so graceful degradation fires.
    expect(supportsViewTransitions()).toBe(false);
  });
});
