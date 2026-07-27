import { describe, expect, it } from "vitest";

import { DEFAULT_ADMISSION_THRESHOLD } from "./admission";
import { ADMISSION_EVIDENCE } from "./admission-evidence";

describe("committed admission evidence", () => {
  it("keeps normally admitted candidates complete and at or above 60%", () => {
    const admitted = ADMISSION_EVIDENCE.filter((entry) => entry.status === "admitted");

    expect(admitted.map((entry) => entry.provider)).toEqual(["google", "cerebras"]);
    for (const entry of admitted) {
      expect(entry.run.complete).toBe(true);
      expect(entry.run.passed / entry.run.total).toBeGreaterThanOrEqual(
        DEFAULT_ADMISSION_THRESHOLD,
      );
    }
  });

  it("keeps every mark's dimensions adding up to the checks it claims", () => {
    // A mark is one run: if the breakdown does not sum to the total, one of the two
    // numbers was edited by hand and the pool is admitting on fiction.
    for (const entry of ADMISSION_EVIDENCE) {
      const passed = entry.run.dimensions.reduce((sum, d) => sum + d.passed, 0);
      const total = entry.run.dimensions.reduce((sum, d) => sum + d.total, 0);
      expect({ passed, total }, entry.provider).toEqual({
        passed: entry.run.passed,
        total: entry.run.total,
      });
    }
  });

  it("names which marks say nothing about the write path", () => {
    // Not a nicety: a reading-only mark means the pool admits that model on
    // evidence that cannot see whether it fakes a proposal (ADR 0067). When one of
    // these is finally re-run, this test is what says «add the dimension».
    const dimensionsOf = (provider: string) =>
      ADMISSION_EVIDENCE.find((entry) => entry.provider === provider)?.run.dimensions.map(
        (dimension) => dimension.dimension,
      );

    expect(dimensionsOf("google")).toEqual(["reading", "tool-discipline"]);
    expect(dimensionsOf("cerebras")).toEqual(["reading", "tool-discipline"]);
    // Groq's is the one mark that predates the dimension, because its free tier
    // cannot accept a single request of the current turn (#1278).
    expect(dimensionsOf("groq")).toEqual(["reading"]);
  });

  it("requires the write-path dimension itself to clear the threshold where it exists", () => {
    for (const entry of ADMISSION_EVIDENCE) {
      const writePath = entry.run.dimensions.find(
        (dimension) => dimension.dimension === "tool-discipline",
      );
      if (!writePath) continue;
      expect(writePath.passed / writePath.total, entry.provider).toBeGreaterThanOrEqual(
        DEFAULT_ADMISSION_THRESHOLD,
      );
    }
  });

  it("represents incumbent Groq as grandfathered with its partial run and reason", () => {
    const groq = ADMISSION_EVIDENCE.find((entry) => entry.provider === "groq");

    expect(groq).toMatchObject({
      status: "grandfathered",
      model: "llama-3.3-70b-versatile",
      run: {
        complete: false,
        passed: 11,
        total: 14,
        executedQuestions: 6,
        totalQuestions: 12,
      },
    });
    expect(groq && "reason" in groq ? groq.reason.length : 0).toBeGreaterThan(0);
  });
});
