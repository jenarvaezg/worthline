import { describe, expect, it } from "vitest";
import { contributionCadenceWords } from "./contribution-cadence-words";

describe("contributionCadenceWords", () => {
  it("reads the weekday as ISO: 1 is Monday and 7 is Sunday", () => {
    expect(contributionCadenceWords({ kind: "weekly", weekday: 1 })).toBe("cada lunes");
    expect(contributionCadenceWords({ kind: "weekly", weekday: 3 })).toBe(
      "cada miércoles",
    );
    expect(contributionCadenceWords({ kind: "weekly", weekday: 7 })).toBe("cada domingo");
  });

  it("names the day of the month", () => {
    expect(contributionCadenceWords({ kind: "monthly", dayOfMonth: 17 })).toBe(
      "el día 17 de cada mes",
    );
  });

  it("says quarterly and annual the way the plan's cadence labels do", () => {
    expect(contributionCadenceWords({ kind: "quarterly" })).toBe("cada trimestre");
    expect(contributionCadenceWords({ kind: "annual" })).toBe("cada año");
  });
});
