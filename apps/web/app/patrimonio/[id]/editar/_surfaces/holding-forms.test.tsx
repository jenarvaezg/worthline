import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { AssetEditForm, OwnershipInputs } from "./holding-forms";

describe("AssetEditForm — investment settings", () => {
  test("renders provider symbol controls for investment holdings", () => {
    const markup = renderToStaticMarkup(
      <AssetEditForm
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

    expect(markup).toContain("Símbolo del proveedor");
    expect(markup).toContain('name="providerSymbol"');
    expect(markup).toContain('value="0P00000RN9.F"');
    expect(markup).toContain("Yahoo Finance");
  });
});

describe("AssetEditForm — edit wording", () => {
  test("does not expose raw asset types in editable copy", () => {
    const markup = renderToStaticMarkup(
      <AssetEditForm
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

    expect(markup).not.toContain(">Cash<");
    expect(markup).not.toContain(">Manual<");
    expect(markup).not.toContain(">Inmueble<");
    expect(markup).toContain(">Cuenta o efectivo<");
    expect(markup).toContain(">Activo general<");
    expect(markup).toContain(">Vivienda o inmueble<");
    expect(markup).toContain("Disponibilidad");
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
});
