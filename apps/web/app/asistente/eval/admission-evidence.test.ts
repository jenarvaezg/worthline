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
    //
    // Read the lists below for what they do NOT contain either. Gemini's mark carries
    // `attachments` since #1342 re-ran it; Cerebras's still does not, because its run
    // predates #1254 — so for that entry the pool admits on evidence that says nothing
    // about a turn carrying a document, which is the half of the write path where PRD
    // #1241's incident happened. The marks are `as const satisfies`, so this is a
    // compile-time fact as much as a test one: a re-run adds the dimension here and
    // the expectation moves with it.
    const dimensionsOf = (provider: string) =>
      ADMISSION_EVIDENCE.find((entry) => entry.provider === provider)?.run.dimensions.map(
        (dimension) => dimension.dimension,
      );

    expect(dimensionsOf("google")).toEqual(["reading", "tool-discipline", "attachments"]);
    expect(dimensionsOf("cerebras")).toEqual(["reading", "tool-discipline"]);
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

  it("carries no grandfathered mark at all", () => {
    // #1278 retired the one entry that had one (Groq, whose free tier cannot accept
    // a single request of the current turn). «Admitted» and «in the pool» are the
    // same statement now, and this is what says so if a mark is ever pasted back.
    for (const entry of ADMISSION_EVIDENCE) {
      expect(entry.status, entry.provider).toBe("admitted");
      expect(entry.run.executedQuestions, entry.provider).toBe(entry.run.totalQuestions);
    }
    expect(ADMISSION_EVIDENCE.map((entry) => entry.provider)).toEqual([
      "google",
      "cerebras",
    ]);
  });
});
