import { describe, expect, it } from "vitest";

import { parseExtractorEvalArgs } from "./args";

describe("parseExtractorEvalArgs", () => {
  it("defaults to a strict threshold and accepts model overrides", () => {
    expect(parseExtractorEvalArgs([])).toEqual({ threshold: 1 });
    expect(
      parseExtractorEvalArgs([
        "--model",
        "gemini-3.5-flash",
        "--threshold",
        "0.9",
        "--output",
        "/tmp/report.json",
        "--only",
        "synthetic-baseline",
        "mobile",
      ]),
    ).toEqual({
      model: "gemini-3.5-flash",
      only: ["synthetic-baseline", "mobile"],
      output: "/tmp/report.json",
      threshold: 0.9,
    });
  });

  it("rejects invalid thresholds", () => {
    expect(() => parseExtractorEvalArgs(["--threshold", "2"])).toThrow(
      "--threshold must be a number between 0 and 1.",
    );
  });
});
