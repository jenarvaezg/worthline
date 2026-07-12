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
