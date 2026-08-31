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
 * The raw «Saldo pendiente» form writes `liabilities.current_balance_minor`, a
 * field the engine only reads as a fallback (#1290). Rendering it for a debt with
 * a modelled curve is a write into the void: the user "saves" and no figure moves.
 */
describe("LiabilityEditForm — raw balance door (#1290)", () => {
  const liability: Liability = {
    currency: "EUR",
    currentBalance: { amountMinor: 587_918, currency: "EUR" },
    id: "debt_prestamos_revolut",
    name: "Préstamos Revolut",
    ownership: [{ memberId: "m1", shareBps: 10_000 }],
    type: "debt",
  };

  const render = (showRawBalanceForm: boolean): string =>
    renderToStaticMarkup(
      <LiabilityEditForm
        assets={[]}
        boardHref="/patrimonio#wl_hld_liab"
        currentUrl="/patrimonio/wl_hld_liab/editar"
        liability={liability}
        members={[{ id: "m1", name: "Jose" }]}
        scopeMemberId="m1"
        showRawBalanceForm={showRawBalanceForm}
        values={{}}
      />,
    );

  test("a debt whose figure comes from the stored field keeps the form", () => {
    const markup = render(true);

    expect(markup).toContain("Saldo pendiente (EUR)");
    expect(markup).toContain('name="balance"');
    expect(markup).toContain("Actualizar saldo");
  });

  test("a debt with a modelled curve exposes no raw balance input", () => {
    const markup = render(false);

    expect(markup).not.toContain("Saldo pendiente");
    expect(markup).not.toContain('name="balance"');
    expect(markup).not.toContain("Actualizar saldo");
    // The identity form still renders — only the balance door is gone.
    expect(markup).toContain("Nombre de la deuda");
  });

  test("the stale stored figure never reaches the page for a curved debt", () => {
    // 5.879,18 € is the zombie from the report: shown while the curve said
    // 5.494,98 €. It must not be printed anywhere on the surface.
    expect(render(false)).not.toContain("5879,18");
    expect(render(true)).toContain("5879,18");
  });
});
