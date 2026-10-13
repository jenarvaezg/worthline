import type { Liability } from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { AssetEditForm, LiabilityEditForm, OwnershipInputs } from "./holding-forms";

describe("AssetEditForm — investment settings", () => {
  test("renders provider symbol controls for investment holdings", () => {
    const markup = renderToStaticMarkup(
      <AssetEditForm
        boardHref="/patrimonio#wl_hld_a"
        currentUrl="/patrimonio/wl_hld_a/editar"
        asset={
          {
            currency: "EUR",
            currentValue: { amountMinor: 94964, currency: "EUR" },
            id: "asset_fund",
            instrument: "fund",
            isPrimaryResidence: false,
            liquidityTier: "market",
            name: "Vanguard Fund",
            ownership: [{ memberId: "m1", shareBps: 10000 }],
            type: "investment",
          } as const
        }
        investment={{
          currency: "EUR",
          id: "asset_fund",
          instrument: "fund",
          liquidityTier: "market",
          name: "Vanguard Fund",
          ownership: [{ memberId: "m1", shareBps: 10000 }],
          priceProvider: "yahoo",
          providerSymbol: "0P00000RN9.F",
        }}
        members={[{ id: "m1", name: "Jose" }]}
        method="derived"
        privacyMode={false}
        scopeMemberId="m1"
        updateInvestmentAction={() => undefined}
        values={{}}
      />,
    );

    expect(markup).toContain("Símbolo de precio");
    expect(markup).toContain('name="providerSymbol"');
    expect(markup).toContain('value="0P00000RN9.F"');
    expect(markup).toContain("Yahoo Finance");
  });
});

describe("AssetEditForm — the instrument picker (#1512)", () => {
  test("offers the hand-valued instruments by name, never the raw AssetType", () => {
    const markup = renderToStaticMarkup(
      <AssetEditForm
        boardHref="/patrimonio#wl_hld_a"
        currentUrl="/patrimonio/wl_hld_a/editar"
        asset={{
          currency: "EUR",
          currentValue: { amountMinor: 120_000_00, currency: "EUR" },
          id: "asset_home",
          instrument: "property",
          isPrimaryResidence: true,
          liquidityTier: "housing",
          name: "Piso",
          ownership: [{ memberId: "m1", shareBps: 10_000 }],
          type: "real_estate",
        }}
        members={[{ id: "m1", name: "Jose" }]}
        method="appreciating"
        privacyMode={false}
        scopeMemberId="m1"
        values={{}}
      />,
    );

    // #1512 replaced the legacy three-value «Tipo» select (cash / manual /
    // real_estate — the pre-ADR-0014 vocabulary) with the instrument the app
    // actually classifies by. The raw enum values stay out of the copy either way.
    expect(markup).not.toContain(">Cash<");
    expect(markup).not.toContain(">Manual<");
    expect(markup).not.toContain(">real_estate<");
    expect(markup).toContain('name="instrument"');
    expect(markup).not.toContain('name="type"');
    expect(markup).toContain(">Inmueble<");
    expect(markup).toContain(">Cuenta corriente<");
    expect(markup).toContain(">Depósito a plazo<");
    expect(markup).toContain(">Otro<");
    // A `derived` instrument is NOT on offer: this row has no operations ledger.
    expect(markup).not.toContain(">Plan de pensiones<");
    expect(markup).toContain("Disponibilidad");
  });

  test("keeps «Vivienda habitual» only while the holding IS an inmueble", () => {
    const markup = renderToStaticMarkup(
      <AssetEditForm
        boardHref="/patrimonio#wl_hld_a"
        currentUrl="/patrimonio/wl_hld_a/editar"
        asset={{
          currency: "EUR",
          currentValue: { amountMinor: 45_000_00, currency: "EUR" },
          id: "asset_pension",
          instrument: "other",
          isPrimaryResidence: false,
          liquidityTier: "term-locked",
          name: "Pensión Pública",
          ownership: [{ memberId: "m1", shareBps: 10_000 }],
          type: "manual",
        }}
        members={[{ id: "m1", name: "Jose" }]}
        method="stored"
        privacyMode={false}
        scopeMemberId="m1"
        values={{}}
      />,
    );

    expect(markup).not.toContain("Vivienda habitual");
    expect(markup).toContain('name="instrument"');
  });

  test("offers an investment only the instruments valued from a ledger", () => {
    const markup = renderToStaticMarkup(
      <AssetEditForm
        boardHref="/patrimonio#wl_hld_a"
        currentUrl="/patrimonio/wl_hld_a/editar"
        asset={{
          currency: "EUR",
          currentValue: { amountMinor: 94964, currency: "EUR" },
          id: "asset_fund",
          instrument: "fund",
          isPrimaryResidence: false,
          liquidityTier: "market",
          name: "Vanguard Fund",
          ownership: [{ memberId: "m1", shareBps: 10_000 }],
          type: "investment",
        }}
        investment={{
          currency: "EUR",
          id: "asset_fund",
          instrument: "fund",
          liquidityTier: "market",
          name: "Vanguard Fund",
          ownership: [{ memberId: "m1", shareBps: 10_000 }],
          priceProvider: "yahoo",
        }}
        members={[{ id: "m1", name: "Jose" }]}
        method="derived"
        privacyMode={false}
        scopeMemberId="m1"
        updateInvestmentAction={() => undefined}
        values={{}}
      />,
    );

    expect(markup).toContain(">Plan de pensiones<");
    expect(markup).toContain(">Fondo<");
    expect(markup).not.toContain(">Inmueble<");
  });
});

describe("AssetEditForm — el identificador es el del instrumento (#1746)", () => {
  function planForm(
    investment: Record<string, unknown>,
    values: Record<string, string> = {},
  ): string {
    return renderToStaticMarkup(
      <AssetEditForm
        boardHref="/patrimonio#wl_hld_plan"
        currentUrl="/patrimonio/wl_hld_plan/editar"
        asset={
          {
            currency: "EUR",
            currentValue: { amountMinor: 1_000_00, currency: "EUR" },
            id: "asset_plan",
            instrument: "pension_plan",
            isPrimaryResidence: false,
            liquidityTier: "term-locked",
            name: "MyInvestor S&P 500 PP",
            ownership: [{ memberId: "m1", shareBps: 10_000 }],
            type: "investment",
          } as const
        }
        investment={
          {
            currency: "EUR",
            id: "asset_plan",
            liquidityTier: "term-locked",
            name: "MyInvestor S&P 500 PP",
            ownership: [{ memberId: "m1", shareBps: 10_000 }],
            priceProvider: "finect",
            ...investment,
          } as never
        }
        members={[{ id: "m1", name: "Jose" }]}
        method="derived"
        privacyMode={false}
        scopeMemberId="m1"
        updateInvestmentAction={() => undefined}
        values={values}
      />,
    );
  }

  test("un plan pide su código DGS, no un ISIN que no puede tener", () => {
    const markup = planForm({
      providerSymbol: "N5394-Myinvestor_indexado_sp_500_pp",
      securityId: { kind: "dgs", value: "N5394" },
    });

    expect(markup).toContain("Código DGS");
    expect(markup).toContain('name="securityId"');
    expect(markup).toContain('value="N5394"');
    // La clase declarada viaja: el selector de instrumento puede reclasificarlo en
    // el mismo envío, y entonces el rechazo tiene que poder nombrar el cambio.
    expect(markup).toContain('name="securityIdKind"');
    expect(markup).toContain('value="dgs"');
  });

  test("los dos campos dicen de dónde salen: uno identifica, el otro cotiza", () => {
    const markup = planForm({
      providerSymbol: "N5394-Myinvestor_indexado_sp_500_pp",
      securityId: { kind: "dgs", value: "N5394" },
    });

    expect(markup).toContain("identifica el producto");
    expect(markup).toContain("sembrado del código DGS en el alta");
  });

  test("un plan identificado y sin cotizar ofrece el reintento", () => {
    const markup = planForm({ securityId: { kind: "dgs", value: "N5394" } });

    expect(markup).toContain("Buscar el símbolo por su código DGS");
    expect(markup).toContain('name="seedPlanSymbol"');
  });

  test("con símbolo ya puesto no hay nada que reintentar", () => {
    const markup = planForm({
      providerSymbol: "N5394-Myinvestor_indexado_sp_500_pp",
      securityId: { kind: "dgs", value: "N5394" },
    });

    expect(markup).not.toContain("Buscar el símbolo por su código DGS");
  });

  test("un identificador guardado de otra clase se dice, no se ofrece como propio", () => {
    const markup = planForm({
      providerSymbol: "N5394-Myinvestor_indexado_sp_500_pp",
      securityId: { kind: "isin", value: "IE00B52MJY50" },
    });

    // El ISIN de un plan no identifica nada, y borrarlo en silencio del campo lo
    // escondería: se enseña en una línea que el usuario puede seguir.
    expect(markup).toContain("IE00B52MJY50");
    expect(markup).toContain("no es un código DGS");
  });

  test("un fondo sigue pidiendo su ISIN, con las mismas palabras de antes", () => {
    const markup = renderToStaticMarkup(
      <AssetEditForm
        boardHref="/patrimonio#wl_hld_a"
        currentUrl="/patrimonio/wl_hld_a/editar"
        asset={
          {
            currency: "EUR",
            currentValue: { amountMinor: 94964, currency: "EUR" },
            id: "asset_fund",
            instrument: "fund",
            isPrimaryResidence: false,
            liquidityTier: "market",
            name: "Vanguard Fund",
            ownership: [{ memberId: "m1", shareBps: 10000 }],
            type: "investment",
          } as const
        }
        investment={
          {
            currency: "EUR",
            id: "asset_fund",
            liquidityTier: "market",
            name: "Vanguard Fund",
            ownership: [{ memberId: "m1", shareBps: 10000 }],
            priceProvider: "yahoo",
            providerSymbol: "0P00000RN9.F",
            securityId: { kind: "isin", value: "IE00B52MJY50" },
          } as never
        }
        members={[{ id: "m1", name: "Jose" }]}
        method="derived"
        privacyMode={false}
        scopeMemberId="m1"
        updateInvestmentAction={() => undefined}
        values={{}}
      />,
    );

    expect(markup).toContain("ISIN");
    expect(markup).toContain('value="IE00B52MJY50"');
    expect(markup).not.toContain("Buscar el símbolo por su código DGS");
  });
});

describe("OwnershipInputs", () => {
  test("uses the same human ownership presets as the add assistant", () => {
    const markup = renderToStaticMarkup(
      <OwnershipInputs
        allowPartial={true}
        currentOwnership={[
          { memberId: "m1", shareBps: 6_000 },
          { memberId: "m2", shareBps: 4_000 },
        ]}
        members={[
          { id: "m1", name: "Jose" },
          { id: "m2", name: "Ana" },
        ]}
        scopeMemberId="m1"
        values={{}}
      />,
    );

    expect(markup).toContain("Solo mío");
    expect(markup).toContain("De los dos (mitad y mitad)");
    expect(markup).toContain("Otro reparto…");
    expect(markup).toContain("alguien de fuera");
    expect(markup).not.toContain("100% Jose");
    expect(markup).not.toContain("Repartir a partes iguales");
    expect(markup).not.toContain("Personalizado");
    expect(markup).toContain('name="ownershipPreset"');
    expect(markup).toContain('value="custom"');
  });

  test("the custom-split pane is a CSS :has() reveal, not a details/summary", () => {
    // A radio inside a <summary> checks without ever opening the details
    // (interactive content swallows the toggle), leaving the pane unreachable.
    const markup = renderToStaticMarkup(
      <OwnershipInputs
        allowPartial={true}
        currentOwnership={[{ memberId: "m1", shareBps: 10_000 }]}
        members={[{ id: "m1", name: "Jorge" }]}
        scopeMemberId="m1"
        values={{}}
      />,
    );

    expect(markup).not.toContain("<details");
    expect(markup).not.toContain("<summary");
    expect(markup).toContain('class="ownerCustom"');
    expect(markup).toContain("Porcentaje de Jorge");
  });
});

/**
 * «Lo básico» of a debt is its identity only. The raw «Saldo pendiente» door is the
 * bar's «Actualizar saldo» (#1848), offered while the stored field governs the
 * figure (#1290) — `page.test.tsx` pins that rule; here, that it left this form.
 */
describe("LiabilityEditForm — the identity, without the balance (#1290, #1850)", () => {
  const liability: Liability = {
    currency: "EUR",
    currentBalance: { amountMinor: 587_918, currency: "EUR" },
    id: "debt_prestamos_revolut",
    name: "Préstamos Revolut",
    ownership: [{ memberId: "m1", shareBps: 10_000 }],
    type: "debt",
  };

  test("it exposes no raw balance input, and never prints the stored figure", () => {
    const markup = renderToStaticMarkup(
      <LiabilityEditForm
        assets={[]}
        boardHref="/patrimonio#wl_hld_liab"
        currentUrl="/patrimonio/wl_hld_liab/editar"
        liability={liability}
        members={[{ id: "m1", name: "Jose" }]}
        scopeMemberId="m1"
        values={{}}
      />,
    );

    expect(markup).toContain("Nombre de la deuda");
    expect(markup).not.toContain("Saldo pendiente");
    expect(markup).not.toContain('name="balance"');
    expect(markup).not.toContain("Actualizar saldo");
    // 5.879,18 € is the zombie from the #1290 report.
    expect(markup).not.toContain("5879,18");
  });
});

describe("AssetEditForm — «Datos del activo» en dos columnas (#1830)", () => {
  test("an investment groups what it IS apart from how it is PRICED", () => {
    const markup = renderToStaticMarkup(
      <AssetEditForm
        boardHref="/patrimonio#wl_hld_a"
        currentUrl="/patrimonio/wl_hld_a/editar?pestaña=datos"
        asset={
          {
            currency: "EUR",
            currentValue: { amountMinor: 12_000_00, currency: "EUR" },
            id: "asset_fund",
            instrument: "fund",
            isPrimaryResidence: false,
            liquidityTier: "market",
            name: "Fondo Azul",
            ownership: [{ memberId: "m1", shareBps: 10_000 }],
            type: "investment",
          } as const
        }
        investment={
          {
            currency: "EUR",
            id: "asset_fund",
            liquidityTier: "market",
            name: "Fondo Azul",
            ownership: [{ memberId: "m1", shareBps: 10_000 }],
            priceProvider: "yahoo",
            providerSymbol: "IWDA.AS",
            securityId: { kind: "isin", value: "IE00B4L5Y983" },
          } as never
        }
        members={[{ id: "m1", name: "Jose" }]}
        method="derived"
        privacyMode={false}
        scopeMemberId="m1"
        updateInvestmentAction={() => undefined}
        values={{}}
      />,
    );

    const identityAt = markup.indexOf("<legend>Identidad</legend>");
    const priceAt = markup.indexOf("<legend>Precio</legend>");
    expect(identityAt).toBeGreaterThan(-1);
    expect(priceAt).toBeGreaterThan(identityAt);
    const identity = markup.slice(identityAt, priceAt);
    const price = markup.slice(priceAt, markup.indexOf("Guardar cambios"));

    for (const field of ["name", "instrument", "liquidityTier", "securityId"]) {
      expect(identity).toContain(`name="${field}"`);
    }
    for (const field of ["priceProvider", "providerSymbol", "manualPricePerUnit"]) {
      expect(price).toContain(`name="${field}"`);
    }
    // One form still: a single save posts both columns.
    expect(markup.match(/<form/g)).toHaveLength(1);
  });
});
