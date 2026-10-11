/**
 * The Rentas ledger's markup (#1673): the list where every income is seen, each one
 * saying whether it counts, and the declaration door underneath — with «sin
 * declarar» a visible, checked choice and the provenance left for the person to pick.
 */

import type { Income } from "@worthline/domain";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { IncomesLedger } from "./incomes-ledger";

const noop = async () => {};

function income(over: Partial<Income> = {}): Income {
  return {
    id: "inc_pension",
    holdingId: null,
    nature: "passive",
    amountBasis: "real",
    assumedContributionThrough: "2030-10-31",
    provenance: "official_simulation",
    provenanceAsOf: "2026-08-18",
    label: "Pensión pública",
    amountMinor: 150_000,
    expensesMinor: null,
    cadence: "monthly",
    startISO: "2030-11-01",
    endISO: null,
    exclusions: [],
    ...over,
  };
}

function render(overrides: Partial<ComponentProps<typeof IncomesLedger>> = {}) {
  return renderToStaticMarkup(
    <IncomesLedger
      createAction={noop}
      currency="EUR"
      currentUrl="/objetivos/rentas"
      deleteAction={noop}
      holdingById={{}}
      incomes={[]}
      initialError={null}
      initialValues={{}}
      privacyMode={false}
      readOnly={false}
      today="2026-10-11"
      updateAction={noop}
      {...overrides}
    />,
  );
}

/** The radios of one group, as `value → checked`. */
function radios(html: string, name: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const tag of html.match(/<input[^>]*type="radio"[^>]*>/g) ?? []) {
    if (!tag.includes(`name="${name}"`)) continue;
    const value = /value="([^"]*)"/.exec(tag)?.[1] ?? "";
    out[value] = /\schecked=""/.test(tag);
  }
  return out;
}

describe("the list", () => {
  test("empty, it says what belongs here and that it is not an asset", () => {
    const html = render();

    expect(html).toContain("0 rentas");
    expect(html).toContain("no son activos");
  });

  test("an income with no asset is listed whole, saying when the sustainable spending reads it", () => {
    const html = render({ incomes: [income()] });

    expect(html).toContain("Pensión pública");
    expect(html).toContain("Sin activo");
    expect(html).toContain("Mensual · desde 1 nov 2030");
    expect(html).toContain("Contará");
    expect(html).toContain("Contará en tu gasto sostenible desde el 1 nov 2030");
    expect(html).toContain("Simulación oficial, con datos a 18 ago 2026");
    expect(html).toContain("Supone seguir cotizando hasta el 31 oct 2030");
  });

  test("an undeclared nature names that as the reason", () => {
    const html = render({ incomes: [income({ nature: null })] });

    expect(html).toContain(
      "Naturaleza sin declarar: esta renta no cuenta en las cifras.",
    );
  });

  test("a linked income links to its holding's Cobros and says it counts", () => {
    const html = render({
      holdingById: {
        asset_flat: {
          href: "/patrimonio/wl_hld_x/editar?abrir=cobros#cobros",
          name: "Piso",
        },
      },
      incomes: [
        income({ holdingId: "asset_flat", label: "Alquiler", startISO: "2024-01-01" }),
      ],
    });

    expect(html).toContain('href="/patrimonio/wl_hld_x/editar?abrir=cobros#cobros"');
    expect(html).toContain(">Cuenta<");
  });

  test("a linked income whose holding is in the Papelera says it does not count", () => {
    const html = render({
      holdingById: {},
      incomes: [
        income({ holdingId: "asset_gone", label: "Alquiler", startISO: "2024-01-01" }),
      ],
    });

    expect(html).toContain("Generada por un activo que está en la Papelera");
    expect(html).toContain(">No cuenta<");
    expect(html).toContain("Su activo está en la Papelera");
  });

  test("the basis note says plainly that a nominal or undeclared amount does not count", () => {
    const html = render();

    expect(html).toContain("solo cuenta un importe en");
    expect(html).toMatch(
      /En euros de cada cobro \(nominal\) o[\s\S]*?no cuenta en ninguna cifra\./,
    );
    expect(html).not.toContain("no se cuenta como si lo fuera");
  });

  test("every stored row can be corrected and deleted", () => {
    const html = render({ incomes: [income()] });

    expect(html).toContain("Corregir la declaración");
    expect(html).toContain('name="incomeId" value="inc_pension"');
    expect(html).toContain('aria-label="Eliminar Pensión pública"');
  });
});

describe("the declaration door", () => {
  test("«sin declarar» is a visible choice, checked until the person picks another", () => {
    const html = render();

    expect(radios(html, "nature")).toEqual({ "": true, passive: false, work: false });
    expect(radios(html, "amountBasis")).toEqual({
      "": true,
      nominal: false,
      real: false,
    });
    expect(html).toContain("Sin declarar");
    expect(html).toContain("no cuenta en ninguna cifra");
  });

  test("the provenance has no default: nothing is chosen for the person", () => {
    expect(radios(render(), "provenance")).toEqual({
      official_simulation: false,
      user_estimate: false,
    });
  });

  test("the cut-off date has no default either — it is the data's date, not today's", () => {
    expect(render()).toContain('name="provenanceAsOf" value=""');
  });

  test("no native `required`: the refusal is a sentence, never a silent blocked submit", () => {
    expect(render()).not.toMatch(/\srequired(=|\s|\/|>)/);
  });

  test("an income with no asset is not offered the costs of a holding", () => {
    expect(render()).not.toContain('name="expenses"');
  });

  test("a refused no-JS post comes back with its reason and its typed fields", () => {
    const html = render({
      initialError: "Indica la fecha de corte de la cifra.",
      initialValues: { label: "Pensión pública", nature: "passive" },
    });

    expect(html).toContain('role="alert"');
    expect(html).toContain("Indica la fecha de corte de la cifra.");
    expect(html).toContain('value="Pensión pública"');
    expect(radios(html, "nature")).toEqual({ "": false, passive: true, work: false });
  });
});
