import type { MyInvestorSchedule } from "@web/ajustes/myinvestor-contributions";
import { describe, expect, test } from "vitest";
import {
  scheduledContributionMissingText,
  scheduledContributionView,
} from "./scheduled-contribution-view";

function schedule(overrides: Partial<MyInvestorSchedule> = {}): MyInvestorSchedule {
  return {
    active: true,
    amountMinor: 8_743,
    assetId: "pp",
    currency: "EUR",
    endDate: "2045-03-05",
    fromAccount: "Cuenta Huerto",
    id: "c-1",
    line: {
      amount: { mode: "money", value: 8_743 },
      cadence: { dayOfMonth: 5, kind: "monthly" },
      destinationHoldingId: "pp",
      endDate: "2045-03-05",
      id: "c-1",
      startDate: "2025-03-05",
    },
    cadence: { dayOfMonth: 5, kind: "monthly" },
    nextDate: "2026-12-05",
    recurrence: "ONE_MONTH",
    startDate: "2025-03-05",
    status: "ACTIVE",
    ...overrides,
  };
}

/** The money formatter puts a no-break space before «€». */
function plain(text: string | undefined): string | undefined {
  return text?.replace(/ /g, " ");
}

const base = {
  ledger: [],
  privacyMode: false,
  readOn: "2026-11-20",
  savedPassword: true,
  today: "2026-11-20",
};

describe("scheduledContributionView", () => {
  test("a running schedule: amount, day, account, next and end, and the note that it warns", () => {
    const [block] = scheduledContributionView([schedule()], base).blocks;
    expect(block?.lead).toBe("Programada en MyInvestor:");
    expect(plain(block?.line)).toBe(
      "87,43 € el día 5 de cada mes, desde Cuenta Huerto. Próxima: 5 dic 2026. Hasta 5 mar 2045.",
    );
    expect(scheduledContributionView([schedule()], base).note).toBe(
      "Se cambia en MyInvestor; worthline la lee al ponerse al día. Si una no llega a los 5 días hábiles, te avisa.",
    );
    expect(block?.rows[0]).toEqual({
      date: "5 dic 2026",
      key: "2026-12-05",
      order: "—",
      status: "programada",
      tone: null,
    });
    expect(block?.rows[1]).toEqual({
      date: "5 nov 2026",
      key: "2026-11-05",
      order: "—",
      status: "no ha llegado",
      tone: "missing",
    });
  });

  test("without the saved password it cannot warn, and says so", () => {
    const view = scheduledContributionView([schedule()], {
      ...base,
      savedPassword: false,
    });
    expect(view.note).toBe(
      "Se cambia en MyInvestor; worthline la lee al ponerse al día. Sin la contraseña guardada no puede avisarte de si llega.",
    );
    expect(view.blocks[0]?.rows[1]?.status).toBe("sin comprobar");
    expect(view.missing).toEqual([]);
  });

  test("a cancelled one says so, with what it was", () => {
    const [block] = scheduledContributionView(
      [
        schedule({
          active: false,
          line: {
            amount: { mode: "money", value: 8_743 },
            cadence: { dayOfMonth: 5, kind: "monthly" },
            destinationHoldingId: "pp",
            endDate: "2026-07-04",
            id: "c-1",
            startDate: "2025-03-05",
          },
          nextDate: "2026-07-05",
          status: "CANCELED",
        }),
      ],
      base,
    ).blocks;
    // No «Programada en MyInvestor:» before a line that says it was cancelled.
    expect(block?.lead).toBeNull();
    expect(plain(block?.line)).toBe(
      "Cancelada en MyInvestor; la última programada fue la del 5 jun 2026. Era de 87,43 € el día 5 de cada mes, desde Cuenta Huerto.",
    );
  });

  test("a cancelled one with no calendar is still said by its cadence, never by its status", () => {
    const [block] = scheduledContributionView(
      [schedule({ active: false, line: null, nextDate: null, status: "CANCELED" })],
      base,
    ).blocks;
    expect(plain(block?.line)).toBe(
      "Cancelada en MyInvestor. Era de 87,43 € el día 5 de cada mes, desde Cuenta Huerto.",
    );
    expect(block?.rows).toEqual([]);
  });

  test("two schedules on one holding never both arrive on one order", () => {
    const view = scheduledContributionView(
      [schedule(), schedule({ amountMinor: 4_611, id: "c-2" })],
      {
        ...base,
        ledger: [
          {
            assetId: "pp",
            currency: "EUR",
            executedAt: "2026-11-05",
            feesMinor: 0,
            id: "op-nov",
            kind: "buy",
            pricePerUnit: "8.743",
            units: "10",
          },
        ],
      },
    );
    expect(view.blocks.map((block) => block.rows[1]?.status)).toEqual([
      "llegó",
      "no ha llegado",
    ]);
  });

  test("a stopped one beside a running one is only its line", () => {
    const view = scheduledContributionView(
      [schedule(), schedule({ active: false, id: "c-0", status: "CANCELED" })],
      base,
    );
    expect(view.blocks.map((block) => block.rows.length > 0)).toEqual([true, false]);
  });

  test("the band's words for one that did not arrive", () => {
    expect(
      scheduledContributionMissingText({
        amount: "87,43 €",
        date: "2026-11-05",
      }),
    ).toBe(
      "La aportación del 5 nov 2026 no ha llegado: MyInvestor la tenía programada (87,43 €) y no hay ninguna orden que case.",
    );
  });

  test("privacy mode masks the amounts", () => {
    const [block] = scheduledContributionView([schedule()], {
      ...base,
      privacyMode: true,
    }).blocks;
    expect(block?.line).not.toContain("87,43");
  });
});
