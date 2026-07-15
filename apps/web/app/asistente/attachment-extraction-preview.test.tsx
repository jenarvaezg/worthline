import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { extractedPositionsSchema } from "./attachment-extraction-contract";
import AttachmentExtractionPreview from "./attachment-extraction-preview";

describe("AttachmentExtractionPreview", () => {
  test("shows every position, total, uncertainty and warnings before any bridge", () => {
    const html = renderToStaticMarkup(
      <AttachmentExtractionPreview
        preview={{
          fileName: "cartera.xlsx",
          result: {
            data: extractedPositionsSchema.parse({
              positions: [
                {
                  currency: "EUR",
                  marketValueEur: 1234.56,
                  name: "Fondo global",
                  ticker: "VWCE",
                  units: 10.5,
                },
                {
                  currency: "USD",
                  marketValueEur: 875.25,
                  name: "Tesla",
                  ticker: "TSLA",
                  uncertain: true,
                  units: 4,
                },
              ],
              totalEur: 2109.81,
              warnings: ["Revisa la divisa de Tesla."],
            }),
            status: "valid",
          },
        }}
      />,
    );

    expect(html).toContain("Lectura de cartera.xlsx");
    expect(html).toContain("VWCE");
    expect(html).toContain("TSLA");
    expect(html).toContain("USD");
    expect(html).toContain("Revisar lectura");
    expect(html).toContain("Revisa la divisa de Tesla.");
    expect(html).toContain("2109,81");
    expect(html).toContain("<table");
    expect(html).not.toMatch(/Confirmar|Importar|Guardar/);

    // Each position offers a quick action to the wizard, prefilled, and NEVER a
    // write from the chat nor a misleading operations-import bridge (#989).
    expect(html.match(/href="\/patrimonio\/anadir\?/g)).toHaveLength(2);
    expect(html).toContain(">Llevar al alta<");
    expect(html).toContain("name_fund=Fondo+global");
    expect(html).not.toContain("importar-extracto");
    expect(html).not.toMatch(/<form|<button/);
  });

  test("renders typed nonfatal failures honestly", () => {
    const html = renderToStaticMarkup(
      <AttachmentExtractionPreview
        preview={{
          fileName: "desconocido.csv",
          result: {
            message: "No reconozco las cabeceras de esta hoja.",
            status: "unrecognized",
          },
        }}
      />,
    );

    expect(html).toContain("No reconozco las cabeceras de esta hoja.");
    expect(html).toContain('role="status"');
  });
});
