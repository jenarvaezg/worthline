import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { AssetEditForm } from "./holding-forms";

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
