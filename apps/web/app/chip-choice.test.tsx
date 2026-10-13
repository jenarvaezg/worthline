import { ChipChoice } from "@web/chip-choice";
import type { LiquidityTier, ManualAsset } from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

function asset(
  id: string,
  name: string,
  rung: LiquidityTier,
  euros: number,
  extra: Partial<ManualAsset> = {},
): ManualAsset {
  return {
    currency: "EUR",
    currentValue: { amountMinor: euros * 100, currency: "EUR" },
    id,
    isPrimaryResidence: false,
    liquidityTier: rung,
    name,
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "investment",
    ...extra,
  };
}

/** `count` fondos de Mercado, del mayor (f1) al menor. */
function funds(count: number): ManualAsset[] {
  return Array.from({ length: count }, (_, index) =>
    asset(`f${index + 1}`, `Fondo ${index + 1}`, "market", 10_000 - index),
  );
}

function render(
  options: ManualAsset[],
  selectedIds: string[] = [],
  privacyMode = false,
): string {
  return renderToStaticMarkup(
    <form>
      <ChipChoice
        name="assetIds"
        options={options}
        privacyMode={privacyMode}
        selectedIds={selectedIds}
      />
    </form>,
  );
}

/** Las casillas que el formulario enviaría: con nombre, marcadas y habilitadas. */
function posted(html: string): string[] {
  return [...html.matchAll(/<input[^>]*>/g)]
    .map((match) => match[0])
    .filter(
      (tag) =>
        tag.includes('name="assetIds"') &&
        tag.includes('checked=""') &&
        !tag.includes("disabled"),
    )
    .map((tag) => /value="([^"]+)"/.exec(tag)?.[1] ?? "");
}

/** La cifra que imprime la fila de una opción del libro. */
function ledgerValueFor(html: string, id: string): string {
  return /class="chipLedgerValue">([^<]*)</.exec(ledgerRowFor(html, id))?.[1] ?? "";
}

function ledgerRowFor(html: string, id: string): string {
  const input = html.indexOf(`value="${id}"`);
  return html.slice(html.lastIndexOf("<label", input), html.indexOf("</label>", input));
}

describe("ChipChoice — hasta doce opciones, los chips de siempre (#1837)", () => {
  test("doce opciones se pintan como chips, con su marca, y sin libro", () => {
    const html = render(funds(12), ["f12"]);

    expect(html).toContain('class="chipChoice"');
    expect(html.match(/class="chipMark"/g)).toHaveLength(12);
    expect(html).not.toContain("chipLedger");
    expect(html).not.toContain('type="search"');
    expect(posted(html)).toEqual(["f12"]);
  });

  test("dos chips con el mismo nombre llevan cada uno su código", () => {
    const html = render([
      asset("acc", "Fidelity MSCI World", "market", 2, {
        securityId: { kind: "isin", value: "IE00BYX5NX33" },
      }),
      asset("dist", "Fidelity MSCI World", "market", 1, {
        securityId: { kind: "isin", value: "IE00BYX5MX67" },
      }),
      asset("tef", "Telefónica", "market", 1, { providerSymbol: "TEF.MC" }),
    ]);

    expect(html).toContain("IE00BYX5NX33");
    expect(html).toContain("IE00BYX5MX67");
    // Un nombre único no carga con el código.
    expect(html).not.toContain("TEF.MC");
  });
});

describe("ChipChoice — trece o más, el libro con buscador y cesta (#1837)", () => {
  test("pinta buscador, libro por peldaños y cesta en vez de chips", () => {
    const html = render([
      ...funds(12),
      asset("coche", "Coche familiar", "illiquid", 14_500),
    ]);

    expect(html).not.toContain('class="chipChoice"');
    expect(html).toContain('type="search"');
    expect(html).toContain("Mercado");
    expect(html).toContain("Ilíquido");
    expect(html).toContain('aria-label="Elegidos"');
  });

  test("toda opción tiene su casilla en el libro, también las que esconden la ventana y el pliegue", () => {
    const options = [...funds(12), asset("coche", "Coche familiar", "illiquid", 14_500)];
    const html = render(options, ["f9", "coche"]);

    // Lo que se envía son las casillas del libro, y solo ellas.
    expect(html.match(/name="assetIds"/g)).toHaveLength(options.length);
    expect(posted(html).sort()).toEqual(["coche", "f9"]);
    // f10 queda fuera de los cinco mayores: oculta, no desmontada.
    expect(ledgerRowFor(html, "f10")).toContain("hidden");
    // f9 está marcada: sigue a la vista aunque no esté entre los cinco.
    expect(ledgerRowFor(html, "f9")).not.toContain("hidden");
  });

  test("Ilíquido y Vivienda salen plegados y su cabecera dice lo elegido dentro", () => {
    const html = render(
      [...funds(12), asset("coche", "Coche familiar", "illiquid", 14_500)],
      ["coche"],
    );
    const illiquid = html.slice(html.indexOf("Ilíquido") - 400);

    expect(illiquid).toContain('aria-expanded="false"');
    expect(illiquid).toContain("1 elegido");
  });

  test("la cesta refleja lo marcado y es un espejo sin casillas", () => {
    const html = render([...funds(13)], ["f2", "f11"]);
    const basket = html.slice(
      html.indexOf('aria-label="Elegidos"'),
      html.indexOf("</aside>"),
    );

    expect(basket).toContain("Fondo 2");
    expect(basket).toContain("Fondo 11");
    expect(basket).toContain('aria-label="Quitar Fondo 2"');
    expect(basket).not.toContain("<input");
  });

  test("el valor de cada fila se enmascara en modo privacidad", () => {
    const clear = render(funds(13));
    const masked = render(funds(13), ["f1"], true);

    expect(ledgerValueFor(clear, "f1")).toMatch(/10\.000/);
    expect(ledgerValueFor(masked, "f1")).not.toBe("");
    expect(ledgerValueFor(masked, "f1")).not.toMatch(/\d/);
    expect(masked).not.toMatch(/10\.000/);
  });

  test("dos activos con el mismo nombre se distinguen por su código en el libro y en la cesta", () => {
    const html = render(
      [
        ...funds(11),
        asset("acc", "Fidelity MSCI World", "market", 20_000, {
          securityId: { kind: "isin", value: "IE00BYX5NX33" },
        }),
        asset("dist", "Fidelity MSCI World", "market", 19_000, {
          securityId: { kind: "isin", value: "IE00BYX5MX67" },
        }),
      ],
      ["dist"],
    );
    const basket = html.slice(
      html.indexOf('aria-label="Elegidos"'),
      html.indexOf("</aside>"),
    );

    expect(ledgerRowFor(html, "acc")).toContain("IE00BYX5NX33");
    expect(ledgerRowFor(html, "dist")).toContain("IE00BYX5MX67");
    expect(basket).toContain("IE00BYX5MX67");
    // Y lo oye quien no lo ve: dos «Quitar Fidelity» iguales no se distinguen.
    expect(basket).toContain('aria-label="Quitar Fidelity MSCI World (IE00BYX5MX67)"');
  });
});
