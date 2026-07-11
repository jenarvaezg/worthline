import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import WarningsBand from "./warnings-band";

describe("WarningsBand", () => {
  test("renders nothing when there are no warnings", () => {
    expect(renderToStaticMarkup(<WarningsBand warnings={[]} />)).toBe("");
  });

  test("renders the warning rail when warnings exist", () => {
    const html = renderToStaticMarkup(
      <WarningsBand
        warnings={[
          {
            code: "ZERO_VALUE_ASSET",
            entityId: "asset_cash",
            message: "Caja tiene valor 0",
          },
        ]}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Caja tiene valor 0");
    expect(html).toContain('href="/patrimonio/asset_cash/editar"');
  });
});
