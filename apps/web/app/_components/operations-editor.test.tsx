import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import OperationsEditor from "./operations-editor";

const noop = async () => {};

function render(context: React.ComponentProps<typeof OperationsEditor>["context"] = {}) {
  return renderToStaticMarkup(
    <OperationsEditor
      assetId="asset_1"
      assetName="Fondo Indexado"
      context={context}
      currentUrl="/patrimonio/asset_1/editar"
      deleteAction={noop}
      formError={null}
      operations={[]}
      recordAction={noop}
      today="2026-06-25"
    />,
  );
}

describe("OperationsEditor required/optional convention (#603)", () => {
  test("required fields show no orphan asterisk", () => {
    expect(render()).not.toMatch(/>\*</);
  });

  test("optional field (comisiones) is marked '(opcional)'", () => {
    expect(render()).toContain("(opcional)");
  });

  test("required fields keep their accessible required semantics", () => {
    // Visual asterisk goes, but units/price are still genuinely required.
    expect(render()).toContain('aria-required="true"');
  });
});

describe("price context when the provider fetch failed (#1330)", () => {
  test("a failed price shows the failure, not a zero price", () => {
    const html = render({
      currentUnits: "10",
      priceFreshness: "failed",
      priceRefreshCaption: "Precio actualizado el 7 jul 2026 · Yahoo",
    });

    expect(html).toContain("Último precio");
    expect(html).toContain("Sin precio");
    expect(html).toContain("Fallido");
  });

  test("a known price is still shown with its freshness chip", () => {
    const html = render({
      currentUnits: "10",
      priceFreshness: "fresh",
      unitPrice: "130.5",
    });

    expect(html).toContain("130.5");
    expect(html).toContain("Reciente");
    expect(html).not.toContain("Sin precio");
  });
});
