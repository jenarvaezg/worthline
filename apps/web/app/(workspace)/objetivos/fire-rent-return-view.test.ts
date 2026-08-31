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
  projectedSchedules: [],
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
            scheduleWindow: { endedOnISO: "2026-07-31", startsOnISO: null },
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

    expect(lines[0]?.gloss).toContain("terminó el 31 jul 2026");
    expect(lines[1]?.gloss).toContain("otra divisa");
  });

  test("a rent that ended says the date and names the action that revives it", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      report: {
        applied: [],
        notices: [
          {
            assetId: "a1",
            assetName: "Yeles",
            grossRate: null,
            reason: "no_live_schedule",
            scheduleWindow: { endedOnISO: "2026-09-01", startsOnISO: null },
          },
        ],
      },
    });

    expect(line?.gloss).toContain("terminó el 1 sept 2026");
    expect(line?.gloss).toContain("Reactivar");
    expect(line?.gloss).toContain("retorno por defecto de su tramo");
  });

  test("a rent that starts later says when, and asks the reader to fix nothing", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      report: {
        applied: [],
        notices: [
          {
            assetId: "a1",
            assetName: "Local",
            grossRate: null,
            reason: "no_live_schedule",
            scheduleWindow: { endedOnISO: null, startsOnISO: "2027-01-01" },
          },
        ],
      },
    });

    expect(line?.gloss).toContain("empieza el 1 ene 2027");
    // The regression this ticket exists for: telling a flat that is let in January
    // that its rent "is no longer in force" — or that it "ended" — is simply false.
    expect(line?.gloss).not.toContain("terminó");
    expect(line?.gloss).not.toContain("no está vigente");
    expect(line?.gloss).not.toContain("Reactivar");
  });

  test("one rent ended and another pending says both, without picking a winner", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      report: {
        applied: [],
        notices: [
          {
            assetId: "a1",
            assetName: "Local",
            grossRate: null,
            reason: "no_live_schedule",
            scheduleWindow: { endedOnISO: "2026-09-01", startsOnISO: "2027-01-01" },
          },
        ],
      },
    });

    expect(line?.gloss).toContain("terminó el 1 sept 2026");
    expect(line?.gloss).toContain("empieza el 1 ene 2027");
  });

  test("a window with neither date is the one case that says only «no vigente»", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      report: {
        applied: [],
        notices: [
          {
            assetId: "a1",
            assetName: "Local",
            grossRate: null,
            reason: "no_live_schedule",
            scheduleWindow: { endedOnISO: null, startsOnISO: null },
          },
        ],
      },
    });

    // Not the copy #1511 removed: that one said this WITH the dates sitting in the
    // data. With no date to give, there is nothing more that is true to say.
    expect(line?.gloss).toContain("no está vigente hoy");
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

  test("a withheld rent with a public id links to cobros on the ficha, never the internal id", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      publicIdByAssetId: { asset_casarrubios: "wl_hld_casa" },
      report: {
        applied: [],
        notices: [
          {
            assetId: "asset_casarrubios",
            assetName: "Piso Casarrubios",
            grossRate: 0.063,
            reason: "missing_expenses",
          },
        ],
      },
    });

    expect(line?.href).toBe("/patrimonio/wl_hld_casa/editar?abrir=cobros#cobros");
    expect(line?.href).not.toContain("asset_");
    // The title is the destination: the gloss no longer names «Cobros» or the ficha
    // as a place to go looking (#1510).
    expect(line?.gloss).not.toContain("Cobros");
    expect(line?.gloss).not.toContain("ficha");
  });

  test("a withheld rent without a public id still prints, with no href", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      report: {
        applied: [],
        notices: [
          {
            assetId: "asset_sin_registro",
            assetName: "Piso",
            grossRate: 0.05,
            reason: "missing_expenses",
          },
        ],
      },
    });

    expect(line?.title).toBe("Piso");
    expect(line?.href).toBeNull();
  });

  test("no-live-schedule and foreign-currency withheld lines also link to cobros", () => {
    const lines = fireRentReturnLines({
      formatMoney,
      publicIdByAssetId: { a1: "wl_hld_aaaa", a2: "wl_hld_bbbb" },
      report: {
        applied: [],
        notices: [
          {
            assetId: "a1",
            assetName: "Local",
            grossRate: null,
            reason: "no_live_schedule",
            scheduleWindow: { endedOnISO: "2026-07-31", startsOnISO: null },
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

    expect(lines[0]?.href).toBe("/patrimonio/wl_hld_aaaa/editar?abrir=cobros#cobros");
    expect(lines[1]?.href).toBe("/patrimonio/wl_hld_bbbb/editar?abrir=cobros#cobros");
    expect(lines.every((line) => !line.href?.includes("asset_"))).toBe(true);
  });

  test("an immobilized rent links to tus supuestos, not the ficha", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      publicIdByAssetId: { asset_piso: "wl_hld_piso" },
      report: {
        applied: [],
        notices: [
          {
            assetId: "asset_piso",
            assetName: "Piso",
            grossRate: 0.04,
            reason: "immobilized_not_counted",
          },
        ],
      },
    });

    expect(line?.href).toBe("#supuestos");
    expect(line?.href).not.toContain("asset_");
  });

  test("an applied rent is not a link", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      publicIdByAssetId: { "a-naval": "wl_hld_naval" },
      report: { applied: [APPLIED], notices: [] },
    });

    expect(line?.href).toBeNull();
  });
});

describe("fireRentReturnLines — the lease terms (#1521)", () => {
  test("a rate resting on a rent whose contract ended says so, in the owner's words", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      report: {
        applied: [
          {
            ...APPLIED,
            projectedSchedules: [{ scheduleId: "s1", policySource: "declared" }],
          },
        ],
        notices: [],
      },
    });

    expect(line?.gloss).toContain("cuyo contrato ya terminó");
    expect(line?.gloss).toContain("has declarado que sigue rentando");
  });

  test("a renewal implied by the regime is not reported as the owner's own declaration", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      report: {
        applied: [
          {
            ...APPLIED,
            projectedSchedules: [{ scheduleId: "s1", policySource: "regime" }],
          },
        ],
        notices: [],
      },
    });

    expect(line?.gloss).toContain("cuyo contrato ya terminó");
    expect(line?.gloss).toContain("por el régimen que has declarado");
    // Putting a declaration he never made in his mouth is the failure to avoid.
    expect(line?.gloss).not.toContain("has declarado que sigue rentando");
  });

  test("a rate built only from rents in force claims no projection", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      report: { applied: [APPLIED], notices: [] },
    });

    expect(line?.gloss).not.toContain("ya terminó");
  });

  test("a nominal rent is told why its yield is not real, and what would change it", () => {
    const [line] = fireRentReturnLines({
      formatMoney,
      report: {
        applied: [],
        notices: [
          {
            assetId: "a1",
            assetName: "Piso Yeles",
            grossRate: 0.063,
            reason: "nominal_rent_revision",
          },
        ],
      },
    });

    expect(line?.kind).toBe("withheld");
    expect(line?.gloss).toContain("no se revisa");
    // The gross is named as what it is NOT, never as an invitation to use it.
    expect(line?.gloss).toContain("6,3 %");
    expect(line?.gloss).toContain("retorno por defecto de su tramo");
    expect(line?.gloss).toContain("referencia legal");
  });
});
