import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import OperationsEditor, { RecordOperationSubmit } from "./operations-editor";

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

describe("double-submit guard on the record button (#1394)", () => {
  test("the idle button is enabled and reads 'Registrar operación'", () => {
    const html = renderToStaticMarkup(<RecordOperationSubmit pending={false} />);

    expect(html).toContain("Registrar operación");
    expect(html).not.toContain("disabled");
  });

  test("while the action is in flight the button is disabled", () => {
    // The second of two clicks never reaches the server: this is what stopped a
    // sell from being recorded twice and eating ~1.000 € of net worth.
    const html = renderToStaticMarkup(<RecordOperationSubmit pending={true} />);

    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Registrando…");
  });

  test("the editor renders the record button in its idle state", () => {
    expect(render()).toContain("Registrar operación");
  });
});
