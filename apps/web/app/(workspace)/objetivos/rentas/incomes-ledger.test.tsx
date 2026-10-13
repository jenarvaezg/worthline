/**
 * The Rentas ledger's markup (#1673): the list where every income is seen, each one
 * saying whether it counts, and the declaration door underneath — with «sin
 * declarar» a visible, checked choice and the provenance left for the person to pick.
 */

import type { Income, StandaloneIncomeCardContext } from "@worthline/domain";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { IncomesLedger } from "./incomes-ledger";

const noop = async () => {};

/** The scope the card reads incomes without an asset in: plan ordinary, everyone in. */
const CARD_READS: StandaloneIncomeCardContext = {
  cardShown: true,
  coversEveryMember: true,
};

/** What the «Naturaleza» note says on each door (#1811). */
const LINKED_NATURE_NOTE = "entra en tu renta pasiva y en tu FIRE";
const STANDALONE_NATURE_NOTE = "No entra en tu renta pasiva ni en tu cifra FIRE";

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
      cardContext={CARD_READS}
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
    expect(html).toContain(
      "Contará en el gasto sostenible de tu plan de jubilación desde el 1 nov 2030",
    );
    expect(html).toContain("Simulación oficial, con datos a 18 ago 2026");
    expect(html).toContain("Supone seguir cotizando hasta el 31 oct 2030");
  });

  // #1811: con el plan en FIRE la tarjeta no se pinta, y Rentas decía «Contará» igual.
  test("an income with no asset says it does not count while the plan is not declared ordinary, and links to where that changes", () => {
    const html = render({
      incomes: [income()],
      cardContext: { cardShown: false, coversEveryMember: true },
    });

    expect(html).toContain(">No cuenta<");
    expect(html).not.toContain(">Contará<");
    expect(html).toContain(
      "esa tarjeta solo aparece con el plan declarado como jubilación ordinaria",
    );
    expect(html).toContain(
      'href="/objetivos#supuestos">Declara tu plan como jubilación ordinaria en tus supuestos</a>',
    );
  });

  test("an income with no asset, looked at from one member's scope, is not attributed to anyone", () => {
    const html = render({
      incomes: [income()],
      cardContext: { cardShown: true, coversEveryMember: false },
    });

    expect(html).toContain(">No cuenta<");
    expect(html).toContain("Sin dueño declarado");
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

    expect(html).toContain("Corregir o terminar");
    expect(html).toContain('name="incomeId" value="inc_pension"');
    expect(html).toContain('aria-label="Eliminar Pensión pública"');
  });

  // #1813: una renta sin activo no tiene ficha, así que su importe y sus fechas se
  // corrigen en su fila de Rentas.
  test("an income with no asset is corrected whole, its recurrence prefilled as stored", () => {
    const html = render({
      incomes: [income({ amountMinor: 162_040, endISO: "2040-10-31" })],
    });

    expect(html).toContain('name="saveRecurrence" value="1"');
    expect(html).toMatch(
      /aria-label="Concepto de Pensión pública"[^>]*value="Pensión pública"/,
    );
    expect(html).toMatch(/aria-label="Importe de Pensión pública"[^>]*value="1620,40"/);
    expect(html).toMatch(
      /name="startISO"[^>]*value="2030-11-01"|value="2030-11-01"[^>]*name="startISO"/,
    );
    expect(html).toMatch(
      /aria-label="Fecha de fin de Pensión pública"[^>]*value="2040-10-31"/,
    );
    // Ending it is named, so ending a life annuity is not a hunt.
    expect(html).toContain("la fecha de su último cobro");
  });

  test("a linked income's correction leaves its recurrence to its ficha", () => {
    const html = render({
      holdingById: { asset_flat: { href: "/patrimonio/asset_flat", name: "Piso" } },
      incomes: [income({ holdingId: "asset_flat", label: "Alquiler" })],
    });

    expect(html).toContain("Corregir la declaración");
    expect(html).not.toContain('name="saveRecurrence"');
    expect(html).not.toContain('aria-label="Importe de Alquiler"');
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

  // #1811: la nota decía que una renta pasiva entra en tu renta pasiva y en tu FIRE,
  // y sin activo no entra en ninguna de las dos.
  test("the nature note on this door says what an income with no asset actually moves", () => {
    const html = render();

    expect(html).toContain(STANDALONE_NATURE_NOTE);
    expect(html).toContain("el gasto sostenible de tu plan de jubilación, en Objetivos");
    expect(html).not.toContain(LINKED_NATURE_NOTE);
  });

  test("correcting a linked income keeps the note of a holding's door", () => {
    const html = render({
      holdingById: { asset_flat: { href: null, name: "Piso" } },
      incomes: [income({ holdingId: "asset_flat", label: "Alquiler" })],
    });

    // Once in the row's correction form, once (the other note) in the door.
    expect(html.split(LINKED_NATURE_NOTE)).toHaveLength(2);
    expect(html.split(STANDALONE_NATURE_NOTE)).toHaveLength(2);
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
