import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { AvailabilitySection } from "./availability-section";

/**
 * La superficie de la fecha de disponibilidad (#1528, ADR 0100). Tres cosas se
 * fijan aquí, y las tres son aceptación del ticket: se pide una FECHA y nunca un
 * importe, lo disponible se DERIVA de esa fecha y del día de lectura, y un holding
 * a plazo sin declarar lo dice en vez de callarlo.
 */
const TODAY = "2026-08-31";

function renderFor(availableFrom: string | null, supersededByLots = false) {
  return renderToStaticMarkup(
    <AvailabilitySection
      assetId="a_pp"
      availableFrom={availableFrom}
      currentUrl="/patrimonio/wl_hld_a_pp/editar"
      formError={null}
      supersededByLots={supersededByLots}
      today={TODAY}
    />,
  );
}

describe("AvailabilitySection — se declara una fecha, no un importe (#1528)", () => {
  test("ofrece un campo de fecha y ninguno de dinero", () => {
    const markup = renderFor(null);

    expect(markup).toContain('name="availableFrom"');
    expect(markup).toContain('type="date"');
    // Un importe disponible caducaría cada año y nadie lo revalidaría (ADR 0074).
    expect(markup).not.toContain('name="accessibleNow"');
    expect(markup).not.toContain('name="availableMinor"');
  });

  test("dice que la fecha no se adivina del libro", () => {
    const markup = renderFor(null);

    expect(markup).toContain("no adivinamos la fecha a partir de tus movimientos");
    expect(markup).toContain("la fecha del trámite");
  });

  test("prellena la fecha declarada tal cual se guardó", () => {
    const markup = renderFor("2035-06-01");

    expect(markup).toContain('value="2035-06-01"');
  });
});

describe("AvailabilitySection — lo disponible se deriva, no se guarda (#1528)", () => {
  test("una fecha futura se lee como los años que faltan desde hoy", () => {
    const markup = renderFor("2035-06-01");

    expect(markup).toContain("dentro de 9 años");
    // La fecha se imprime con la voz de la app (`formatDateKeyEs`), no en ISO.
    expect(markup).toContain("01/06/2035");
  });

  test("una fecha ya pasada dice que ese capital ya se puede tocar", () => {
    const markup = renderFor("2024-01-15");

    expect(markup).toContain("ya se puede tocar");
  });

  test("un solo año se dice en singular", () => {
    const markup = renderFor("2027-06-01");

    expect(markup).toContain("dentro de 1 año");
    expect(markup).not.toContain("dentro de 1 años");
  });
});

describe("AvailabilitySection — el hueco se dice en voz alta (#1528)", () => {
  test("sin fecha declarada explica qué está asumiendo el reparto", () => {
    const markup = renderFor(null);

    expect(markup).toContain("cuenta este dinero como disponible desde el primer año");
  });

  test("con fecha declarada ese aviso desaparece: ya no hay hueco", () => {
    const markup = renderFor("2035-06-01");

    expect(markup).not.toContain("disponible desde el primer año");
  });
});

// Un campo que sigue guardando y ya no decide nada es peor que no estar: el dueño cree
// haber declarado algo que el motor no lee (#1676).
describe("cuando los lotes mandan sobre esta fecha (#1676)", () => {
  test("lo dice en voz alta en vez de dejar la fecha decidiendo en silencio", () => {
    const html = renderFor("2035-06-01", true);

    expect(html).toContain("mandan ellos");
    expect(html).not.toContain("dentro de");
  });

  test("sin lotes la fecha sigue mandando y la lectura se enseña", () => {
    const html = renderFor("2035-06-01", false);

    expect(html).not.toContain("mandan ellos");
    expect(html).toContain("dentro de");
  });
});
