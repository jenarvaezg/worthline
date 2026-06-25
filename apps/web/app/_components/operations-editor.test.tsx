import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import OperationsEditor from "./operations-editor";

const noop = async () => {};

function render() {
  return renderToStaticMarkup(
    <OperationsEditor
      assetId="asset_1"
      assetName="Fondo Indexado"
      context={{}}
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
