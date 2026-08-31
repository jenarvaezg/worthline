import type { AcquisitionAnchorEditPreview } from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  acquisitionConfirmLabel,
  acquisitionDateRoleLabel,
  acquisitionRewriteSentence,
  acquisitionSnapshotCount,
  acquisitionWorstMove,
  acquisitionWorstMoveSentence,
} from "./acquisition-edit-view";

const format = (minor: number) =>
  new Intl.NumberFormat("es-ES", {
    currency: "EUR",
    minimumFractionDigits: 2,
    style: "currency",
  }).format(minor / 100);

function preview(
  overrides: Partial<AcquisitionAnchorEditPreview> = {},
): AcquisitionAnchorEditPreview {
  return {
    dateChanged: true,
    fromDateKey: "2004-05-19",
    points: [
      {
        afterMinor: 16_000_000,
        beforeMinor: 15_025_303,
        dateKey: "2004-05-19",
        deltaMinor: 974_697,
        role: "acquisition_current",
      },
      {
        afterMinor: 20_000_000,
        beforeMinor: 20_000_000,
        dateKey: "2026-01-01",
        deltaMinor: 0,
        role: "appraisal",
      },
    ],
    snapshotsGenerated: 0,
    snapshotsRecalculated: 264,
    valueChanged: true,
    ...overrides,
  };
}

describe("acquisitionRewriteSentence", () => {
  test("says how many snapshots move and from when", () => {
    expect(acquisitionRewriteSentence(preview())).toBe(
      "Guardar reescribirá 264 snapshots del histórico, desde el 19/05/2004.",
    );
  });

  test("adds the snapshot the new date mints", () => {
    expect(acquisitionRewriteSentence(preview({ snapshotsGenerated: 1 }))).toContain(
      "Además creará 1 snapshot nuevo en la fecha de adquisición.",
    );
  });

  test("singularizes one snapshot", () => {
    expect(acquisitionRewriteSentence(preview({ snapshotsRecalculated: 1 }))).toContain(
      "1 snapshot del histórico",
    );
  });

  test("nothing to re-derive is not «reescribirá 0 snapshots»", () => {
    const sentence = acquisitionRewriteSentence(
      preview({ snapshotsGenerated: 1, snapshotsRecalculated: 0 }),
    );
    expect(sentence).toBe(
      "Guardar creará 1 snapshot nuevo en la fecha de adquisición, desde el 19/05/2004.",
    );
    expect(sentence).not.toContain("0 snapshot");
  });

  test("an unchanged acquisition says so instead of counting", () => {
    const unchanged = preview({ dateChanged: false, valueChanged: false });
    expect(acquisitionRewriteSentence(unchanged)).toBe(
      "La fecha y el valor son los que ya están guardados: guardar no cambia nada.",
    );
  });

  test("no history yet is said, not hidden", () => {
    const empty = preview({ snapshotsGenerated: 0, snapshotsRecalculated: 0 });
    expect(acquisitionRewriteSentence(empty)).toContain(
      "Todavía no hay histórico que reescribir",
    );
  });
});

describe("acquisitionConfirmLabel", () => {
  test("the verb carries the consequence, never «Confirmar» (ADR 0070 §4)", () => {
    expect(acquisitionConfirmLabel(preview())).toBe("Reescribir 264 snapshots y guardar");
    expect(acquisitionConfirmLabel(preview())).not.toContain("Confirmar");
  });

  test("one snapshot reads in singular", () => {
    expect(acquisitionConfirmLabel(preview({ snapshotsRecalculated: 1 }))).toBe(
      "Reescribir 1 snapshot y guardar",
    );
  });

  test("counts the minted snapshot too", () => {
    expect(
      acquisitionConfirmLabel(
        preview({ snapshotsGenerated: 1, snapshotsRecalculated: 2 }),
      ),
    ).toBe("Reescribir 3 snapshots y guardar");
  });

  test("with nothing to rewrite it is a plain save", () => {
    expect(
      acquisitionConfirmLabel(
        preview({ snapshotsGenerated: 0, snapshotsRecalculated: 0 }),
      ),
    ).toBe("Guardar adquisición");
    expect(
      acquisitionConfirmLabel(preview({ dateChanged: false, valueChanged: false })),
    ).toBe("Guardar adquisición");
  });
});

describe("acquisitionDateRoleLabel", () => {
  test("names both acquisition dates when the date moves", () => {
    const moved = preview();
    expect(acquisitionDateRoleLabel("acquisition_current", moved)).toBe(
      "Adquisición (fecha actual)",
    );
    expect(acquisitionDateRoleLabel("acquisition_new", moved)).toBe(
      "Adquisición (fecha nueva)",
    );
  });

  test("a price-only edit keeps one plain acquisition label", () => {
    expect(
      acquisitionDateRoleLabel("acquisition_new", preview({ dateChanged: false })),
    ).toBe("Adquisición");
  });

  test("names the other roles", () => {
    const p = preview();
    expect(acquisitionDateRoleLabel("appraisal", p)).toBe("Tasación");
    expect(acquisitionDateRoleLabel("improvement", p)).toBe("Mejora");
    expect(acquisitionDateRoleLabel("today", p)).toBe("Hoy");
    expect(acquisitionDateRoleLabel("curve", p)).toBe("Curva (tramo que se redibuja)");
  });
});

describe("acquisitionWorstMove", () => {
  test("picks the date that moves the most, ignoring the ones that hold", () => {
    expect(acquisitionWorstMove(preview())?.dateKey).toBe("2004-05-19");
  });

  test("null when no date moves", () => {
    const flat = preview({
      points: [
        {
          afterMinor: 20_000_000,
          beforeMinor: 20_000_000,
          dateKey: "2026-01-01",
          deltaMinor: 0,
          role: "appraisal",
        },
      ],
    });
    expect(acquisitionWorstMove(flat)).toBeNull();
    expect(acquisitionWorstMoveSentence(flat, format)).toBeNull();
  });

  test("says both figures of the biggest move", () => {
    // Built through the same formatter: Intl uses a non-breaking space before €.
    expect(acquisitionWorstMoveSentence(preview(), format)).toBe(
      `El mayor cambio es el 19/05/2004: ${format(15_025_303)} pasa a ${format(
        16_000_000,
      )}.`,
    );
  });
});

describe("helpers", () => {
  test("totals the snapshots the rewrite touches", () => {
    expect(acquisitionSnapshotCount(preview({ snapshotsGenerated: 1 }))).toBe(265);
  });
});
