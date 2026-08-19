/**
 * The rent-return disclosure copy (#1448). What is being pinned is honesty: an
 * applied rate names the two figures it came from, and a WITHHELD rent says what is
 * missing and what the gross would have been — the guard against sealing a 6,3 %
 * gross as if it were net.
 */
import type { FireRentReturnReport } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { formatRatePercent } from "./fire-percent";
import { fireRentReturnLines } from "./fire-rent-return-view";

const formatMoney = (amountMinor: number) =>
  new Intl.NumberFormat("es-ES", { currency: "EUR", style: "currency" }).format(
    amountMinor / 100,
  );

const APPLIED: FireRentReturnReport["applied"][number] = {
  annualExpensesMinor: 300_000,
  annualGrossRentMinor: 1_860_000,
  annualNetRentMinor: 1_560_000,
  assetId: "a-naval",
  assetName: "Piso Navalcarnero",
  isNetNegative: false,
  rate: 1_560_000 / 37_000_000,
  scheduleIds: ["s1"],
  scopedValueMinor: 37_000_000,
  valueMinor: 37_000_000,
};

describe("formatRatePercent", () => {
  test("es-ES, one decimal, with the space before the sign", () => {
    expect(formatRatePercent(0.042162)).toBe("4,2 %");
    expect(formatRatePercent(-0.012)).toBe("-1,2 %");
  });
});

describe("fireRentReturnLines", () => {
  test("nothing declared → nothing said", () => {
    expect(
      fireRentReturnLines({ formatMoney, report: { applied: [], notices: [] } }),
    ).toEqual([]);
  });

  test("an applied rate names the yield and both figures behind it", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      report: { applied: [APPLIED], notices: [] },
    });

    expect(line?.kind).toBe("applied");
    expect(line?.title).toBe("Piso Navalcarnero · 4,2 % real");
    expect(line?.gloss).toContain("/año netos sobre");
    expect(line?.gloss).toContain("de alquiler");
    expect(line?.gloss).toContain("de gastos");
  });

  test("costs above the rent are said out loud, not printed as a bare minus", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      report: {
        applied: [
          {
            ...APPLIED,
            annualExpensesMinor: 2_000_000,
            annualNetRentMinor: -140_000,
            isNetNegative: true,
            rate: -140_000 / 37_000_000,
          },
        ],
        notices: [],
      },
    });

    expect(line?.gloss).toContain("los gastos declarados superan al alquiler");
  });

  test("a rent with no declared costs says what is missing and quotes the gross", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      report: {
        applied: [],
        notices: [
          {
            assetId: "a-casarrubios",
            assetName: "Piso Casarrubios",
            grossRate: 0.063,
            reason: "missing_expenses",
          },
        ],
      },
    });

    expect(line?.kind).toBe("withheld");
    expect(line?.title).toBe("Piso Casarrubios");
    expect(line?.gloss).toContain("falta declarar sus gastos");
    expect(line?.gloss).toContain("6,3 %");
    // Never a hardcoded tier figure: `tierRealReturns` can move it per config.
    expect(line?.gloss).not.toContain("3,0 %");
  });

  test("an ended rent and a foreign-currency property each say their own reason", () => {
    const lines = fireRentReturnLines({
      formatMoney,
      report: {
        applied: [],
        notices: [
          {
            assetId: "a1",
            assetName: "Local",
            grossRate: null,
            reason: "no_live_schedule",
          },
          {
            assetId: "a2",
            assetName: "Miami",
            grossRate: null,
            reason: "foreign_currency",
          },
        ],
      },
    });

    // Neutral on purpose: the same reason covers a rent that has not started yet,
    // and telling that user his rent "expired" would be a false statement.
    expect(lines[0]?.gloss).toContain("no está vigente hoy");
    expect(lines[1]?.gloss).toContain("otra divisa");
  });

  test("a co-owned flat says the figures are the whole property's, and what it weighs", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      report: { applied: [{ ...APPLIED, scopedValueMinor: 18_500_000 }], notices: [] },
    });

    // The percentage does not change with the share; the euros do.
    expect(line?.title).toBe("Piso Navalcarnero · 4,2 % real");
    expect(line?.gloss).toContain("Cifras del 100 % del inmueble");
    expect(line?.gloss).toContain("en este ámbito pesa");
  });

  test("a wholly-owned flat says nothing about shares", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      report: { applied: [APPLIED], notices: [] },
    });

    expect(line?.gloss).not.toContain("100 % del inmueble");
  });

  test("applied lines come before withheld ones", () => {
    const lines = fireRentReturnLines({
      formatMoney,
      report: {
        applied: [APPLIED],
        notices: [
          {
            assetId: "a2",
            assetName: "Otro",
            grossRate: 0.05,
            reason: "missing_expenses",
          },
        ],
      },
    });

    expect(lines.map((line) => line.kind)).toEqual(["applied", "withheld"]);
  });
});
