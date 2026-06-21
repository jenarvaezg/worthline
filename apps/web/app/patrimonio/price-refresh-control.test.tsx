import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { PriceRefreshControl } from "./price-refresh-control";

const noop = async () => {};

describe("PriceRefreshControl", () => {
  test("global variant carries the return URL and no asset scope (#405)", () => {
    const html = renderToStaticMarkup(
      <PriceRefreshControl
        action={noop}
        currentUrl="/patrimonio?group=tier"
        label="Actualizar precios"
        pendingLabel="Actualizando…"
      />,
    );

    expect(html).toContain("Actualizar precios");
    expect(html).toContain('name="currentUrl"');
    expect(html).toContain('value="/patrimonio?group=tier"');
    expect(html).not.toContain('name="assetId"');
  });

  test("single-holding variant scopes the refresh to one asset (#406)", () => {
    const html = renderToStaticMarkup(
      <PriceRefreshControl
        action={noop}
        currentUrl="/patrimonio/asset_1/editar"
        assetId="asset_1"
        label="Actualizar precio"
        pendingLabel="Actualizando…"
      />,
    );

    expect(html).toContain("Actualizar precio");
    expect(html).toContain('name="assetId"');
    expect(html).toContain('value="asset_1"');
  });
});
