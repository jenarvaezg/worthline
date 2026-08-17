import type { AmortizationScheduleImportPlan } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  rebaselineNoticeSentence,
  scheduleVerdict,
  scheduleVerificationSentence,
  scheduleWriteSentence,
  scheduleWritesSomething,
} from "./schedule-import-summary";

const format = (minor: number) => `${(minor / 100).toFixed(2)} €`;

function plan(
  overrides: Omit<Partial<AmortizationScheduleImportPlan>, "summary"> & {
    summary?: Partial<AmortizationScheduleImportPlan["summary"]>;
  } = {},
): AmortizationScheduleImportPlan {
  const { summary, ...rest } = overrides;
  return {
    checkpoints: [],
    earlyRepayments: [],
    rateScaleAdjusted: false,
    revisions: [],
    summary: {
      agreeingCount: 0,
      checkedCount: 0,
      duplicateEarlyRepaymentCount: 0,
      duplicateRevisionCount: 0,
      newEarlyRepaymentCount: 0,
      newRevisionCount: 0,
      outsideTermCount: 0,
      rippleFromDateKey: null,
      worstDrift: null,
      ...summary,
    },
    warnings: [],
    ...rest,
  };
}

describe("scheduleVerdict", () => {
  test("every checkpoint agreeing is a verified reading", () => {
    expect(
      scheduleVerdict(plan({ summary: { agreeingCount: 3, checkedCount: 3 } })),
    ).toBe("verified");
  });

  test("some agreeing is partial, none is unverified", () => {
    expect(
      scheduleVerdict(plan({ summary: { agreeingCount: 1, checkedCount: 3 } })),
    ).toBe("partial");
    expect(
      scheduleVerdict(plan({ summary: { agreeingCount: 0, checkedCount: 3 } })),
    ).toBe("unverified");
  });

  test("a document that declares no balance cannot check itself", () => {
    expect(scheduleVerdict(plan())).toBe("nothing-to-check");
  });
});

describe("the sentences", () => {
  test("a verified reading says so plainly", () => {
    expect(
      scheduleVerificationSentence(
        plan({ summary: { agreeingCount: 2, checkedCount: 2 } }),
        format,
      ),
    ).toContain("La lectura es correcta");
  });

  test("a partial reading names the worst checkpoint and its drift", () => {
    const sentence = scheduleVerificationSentence(
      plan({
        summary: {
          agreeingCount: 1,
          checkedCount: 3,
          worstDrift: { dateKey: "2006-05-01", deltaMinor: 180_304 },
        },
      }),
      format,
    );
    expect(sentence).toContain("2006-05-01");
    expect(sentence).toContain("1803.04 €");
  });

  test("a mismatch is stated as confirmable, never as a lock (ADR 0070 §4)", () => {
    const sentence = scheduleVerificationSentence(
      plan({
        summary: {
          agreeingCount: 0,
          checkedCount: 4,
          worstDrift: { dateKey: "2010-05-01", deltaMinor: -900_00 },
        },
      }),
      format,
    );
    expect(sentence).toContain("Puedes cargarlo igualmente");
  });

  test("what will be written is counted in Spanish", () => {
    expect(
      scheduleWriteSentence(
        plan({ summary: { newEarlyRepaymentCount: 1, newRevisionCount: 21 } }),
      ),
    ).toBe("21 revisiones de tipo y 1 amortización anticipada");
    expect(scheduleWriteSentence(plan({ summary: { newRevisionCount: 1 } }))).toBe(
      "1 revisión de tipo",
    );
  });

  test("nothing new to write is the one thing that disables confirming", () => {
    expect(
      scheduleWritesSomething(plan({ summary: { duplicateRevisionCount: 21 } })),
    ).toBe(false);
    expect(scheduleWritesSomething(plan({ summary: { newRevisionCount: 1 } }))).toBe(
      true,
    );
  });

  test("a re-baselined stretch is named, so the user knows what is not being touched", () => {
    const notice = rebaselineNoticeSentence(
      plan({
        checkpoints: [
          {
            agrees: true,
            curveMinor: 1,
            dateKey: "2024-05-01",
            declaredMinor: 1,
            deltaMinor: 0,
            governedBy: "rebaseline",
          },
        ],
      }),
    );
    expect(notice).toContain("2024-05-01");
    expect(rebaselineNoticeSentence(plan())).toBeNull();
  });
});
