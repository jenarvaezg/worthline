import { describe, expect, it } from "vitest";

import { GOLDEN_QUESTIONS } from "./golden";
import type { AssistantAnswer } from "./graders";

const EMPTY: AssistantAnswer = { text: "", toolNames: [], quickActions: [] };
const PERSONAS = new Set(["familia", "inversor", "joven"]);

describe("golden question set", () => {
  it("has 10–15 questions", () => {
    expect(GOLDEN_QUESTIONS.length).toBeGreaterThanOrEqual(10);
    expect(GOLDEN_QUESTIONS.length).toBeLessThanOrEqual(15);
  });

  it("has unique ids and valid personas with non-empty questions", () => {
    const ids = GOLDEN_QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const q of GOLDEN_QUESTIONS) {
      expect(PERSONAS.has(q.persona)).toBe(true);
      expect(q.question.trim().length).toBeGreaterThan(0);
    }
  });

  it("every grader yields named checks for any answer", () => {
    for (const q of GOLDEN_QUESTIONS) {
      const checks = q.grade(EMPTY);
      expect(checks.length).toBeGreaterThan(0);
      for (const c of checks) {
        expect(c.name.trim().length).toBeGreaterThan(0);
        expect(typeof c.pass).toBe("boolean");
      }
    }
  });

  it("covers every persona and includes at least one missing-fact question", () => {
    expect(new Set(GOLDEN_QUESTIONS.map((q) => q.persona))).toEqual(PERSONAS);
    // A missing-fact question passes its honesty check on an empty (declining) answer.
    const missing = GOLDEN_QUESTIONS.filter((q) =>
      q
        .grade({ ...EMPTY, text: "No consta ese dato en tu workspace." })
        .some((c) => c.pass && /no exist|no hay|no consta/i.test(c.name)),
    );
    expect(missing.length).toBeGreaterThanOrEqual(1);
  });
});
