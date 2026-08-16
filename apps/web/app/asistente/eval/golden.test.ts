import { describe, expect, it } from "vitest";

import { GOLDEN_QUESTIONS } from "./golden";
import { ATTACHMENT_QUESTIONS } from "./golden-attachments";
import { READING_QUESTIONS } from "./golden-reading";
import { TOOL_DISCIPLINE_QUESTIONS } from "./golden-tool-discipline";
import type { AssistantAnswer } from "./graders";

const EMPTY: AssistantAnswer = {
  text: "",
  toolCalls: [],
  toolResults: [],
  quickActions: [],
};
const PERSONAS = new Set(["familia", "inversor", "joven"]);

describe("golden question set", () => {
  it("scores all three dimensions, with enough questions in each to mean something", () => {
    expect(READING_QUESTIONS.length).toBeGreaterThanOrEqual(10);
    expect(TOOL_DISCIPLINE_QUESTIONS.length).toBeGreaterThanOrEqual(5);
    expect(ATTACHMENT_QUESTIONS.length).toBeGreaterThanOrEqual(3);
    expect(GOLDEN_QUESTIONS).toEqual([
      ...READING_QUESTIONS,
      ...TOOL_DISCIPLINE_QUESTIONS,
      ...ATTACHMENT_QUESTIONS,
    ]);
  });

  it("tags every question with its own dimension", () => {
    // The tag is what keeps the write path from being outvoted by reading (#1265),
    // so a question that lands in the wrong set is a silent hole in the gate.
    for (const question of READING_QUESTIONS) {
      expect(question.dimension, question.id).toBe("reading");
    }
    for (const question of TOOL_DISCIPLINE_QUESTIONS) {
      expect(question.dimension, question.id).toBe("tool-discipline");
    }
    for (const question of ATTACHMENT_QUESTIONS) {
      expect(question.dimension, question.id).toBe("attachments");
    }
  });

  it("keeps documents inside the attachment set", () => {
    // A question in another set carrying a file would be graded by checks written for
    // a turn with no document — and it would be scored on a dimension whose name says
    // otherwise. The reverse is the #1254 defect in miniature: an attachment question
    // with no document at all grades an ordinary turn while claiming to grade a
    // document — by either route, attached now or validated one turn ago (#1376).
    for (const question of ATTACHMENT_QUESTIONS) {
      expect(
        question.attachment ?? question.validatedDocument,
        question.id,
      ).toBeDefined();
    }
    for (const question of [...READING_QUESTIONS, ...TOOL_DISCIPLINE_QUESTIONS]) {
      expect(question.attachment, question.id).toBeUndefined();
      expect(question.validatedDocument, question.id).toBeUndefined();
    }
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

  it("makes every write-path question fail on a turn that says nothing and does nothing", () => {
    // Silence is not discipline. A question whose checks all passed on an empty
    // answer would inflate the dimension that decides the write path.
    for (const question of [...TOOL_DISCIPLINE_QUESTIONS, ...ATTACHMENT_QUESTIONS]) {
      expect(
        question.grade(EMPTY).some((check) => !check.pass),
        question.id,
      ).toBe(true);
    }
  });

  it("never lets silence earn write-path credit, because most of it is abstention", () => {
    // The trap this documents: three of the five write-path questions grade the
    // model for NOT doing something, so an EMPTY answer still passes most of their
    // checks. That is why `run.ts` scores an errored question as all-failed instead
    // of grading the empty answer — otherwise a provider quota death would score in
    // the model's favour on the dimension that decides the write path.
    const silent = TOOL_DISCIPLINE_QUESTIONS.flatMap((question) => question.grade(EMPTY));
    expect(silent.filter((check) => check.pass).length).toBeGreaterThan(
      silent.length / 3,
    );
  });
});
