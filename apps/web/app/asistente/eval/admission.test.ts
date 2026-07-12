import { describe, expect, it } from "vitest";

import {
  buildAdmissionReport,
  DEFAULT_ADMISSION_THRESHOLD,
  decideAdmission,
  decideSummarizedAdmission,
} from "./admission";

const EXPECTED_QUESTIONS = ["one", "two"];

describe("decideAdmission", () => {
  it("admits a complete run at the default 60% threshold", () => {
    const verdict = decideAdmission({
      expectedQuestionIds: EXPECTED_QUESTIONS,
      questionResults: [
        { id: "one", passed: 3, total: 4 },
        { id: "two", passed: 3, total: 6 },
      ],
    });

    expect(verdict).toEqual({
      admitted: true,
      complete: true,
      passed: 6,
      total: 10,
      ratio: 0.6,
      threshold: DEFAULT_ADMISSION_THRESHOLD,
    });
  });

  it("rejects a complete run below the threshold", () => {
    const verdict = decideAdmission({
      expectedQuestionIds: EXPECTED_QUESTIONS,
      questionResults: [
        { id: "one", passed: 2, total: 4 },
        { id: "two", passed: 3, total: 6 },
      ],
    });

    expect(verdict.admitted).toBe(false);
    expect(verdict.complete).toBe(true);
    expect(verdict.ratio).toBe(0.5);
  });

  it("rejects an incomplete run even when every executed check passed", () => {
    const verdict = decideAdmission({
      expectedQuestionIds: EXPECTED_QUESTIONS,
      questionResults: [{ id: "one", passed: 4, total: 4 }],
    });

    expect(verdict).toMatchObject({
      admitted: false,
      complete: false,
      passed: 4,
      total: 4,
      ratio: 1,
    });
  });

  it("applies a caller-supplied threshold", () => {
    const verdict = decideAdmission({
      expectedQuestionIds: EXPECTED_QUESTIONS,
      questionResults: [
        { id: "one", passed: 3, total: 4 },
        { id: "two", passed: 4, total: 6 },
      ],
      threshold: 0.8,
    });

    expect(verdict).toMatchObject({ admitted: false, ratio: 0.7, threshold: 0.8 });
  });

  it("rejects a complete run with no checks instead of producing NaN", () => {
    const verdict = decideAdmission({
      expectedQuestionIds: EXPECTED_QUESTIONS,
      questionResults: [
        { id: "one", passed: 0, total: 0 },
        { id: "two", passed: 0, total: 0 },
      ],
    });

    expect(verdict).toMatchObject({ admitted: false, complete: true, ratio: 0 });
  });
});

describe("decideSummarizedAdmission", () => {
  it("uses the same canonical default threshold as full admission", () => {
    const total = 1_000;
    const atThreshold = Math.ceil(DEFAULT_ADMISSION_THRESHOLD * total);

    expect(
      decideSummarizedAdmission({ complete: true, passed: atThreshold, total }),
    ).toMatchObject({ admitted: true, threshold: DEFAULT_ADMISSION_THRESHOLD });
    expect(
      decideSummarizedAdmission({ complete: true, passed: atThreshold - 1, total }),
    ).toMatchObject({ admitted: false, threshold: DEFAULT_ADMISSION_THRESHOLD });
  });
});

describe("buildAdmissionReport", () => {
  it("produces a stable machine-readable result with per-question and total checks", () => {
    const report = buildAdmissionReport({
      provider: "google",
      model: "gemini-3.1-flash-lite",
      startedAt: "2026-07-11T20:00:00.000Z",
      finishedAt: "2026-07-11T20:05:00.000Z",
      expectedQuestionIds: ["one", "two"],
      questionResults: [
        {
          id: "one",
          persona: "familia",
          status: "completed",
          checks: [
            { name: "español", pass: true },
            { name: "fuente", pass: false },
          ],
        },
        {
          id: "two",
          persona: "joven",
          status: "error",
          checks: [{ name: "español", pass: false }],
          error: "provider rejected the request",
        },
      ],
    });

    expect(report).toEqual({
      schemaVersion: 1,
      provider: "google",
      model: "gemini-3.1-flash-lite",
      startedAt: "2026-07-11T20:00:00.000Z",
      finishedAt: "2026-07-11T20:05:00.000Z",
      complete: true,
      questions: [
        {
          id: "one",
          persona: "familia",
          status: "completed",
          checks: [
            { name: "español", pass: true },
            { name: "fuente", pass: false },
          ],
          passed: 1,
          total: 2,
        },
        {
          id: "two",
          persona: "joven",
          status: "error",
          checks: [{ name: "español", pass: false }],
          passed: 0,
          total: 1,
          error: "provider rejected the request",
        },
      ],
      summary: {
        admitted: false,
        passed: 1,
        total: 3,
        ratio: 1 / 3,
        threshold: 0.6,
      },
    });
  });
});
