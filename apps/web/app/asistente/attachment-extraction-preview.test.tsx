import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { extractedDocumentSchema } from "./attachment-extraction-contract";
import AttachmentExtractionPreview from "./attachment-extraction-preview";

describe("AttachmentExtractionPreview", () => {
  test("shows every position, total, uncertainty and warnings before any bridge", () => {
    const html = renderToStaticMarkup(
      <AttachmentExtractionPreview
        preview={{
          fileName: "cartera.xlsx",
          result: {
            data: extractedDocumentSchema.parse({
              documentType: "positions",
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

  test("shows a dated balance series with uncertainty, warnings and no wizard bridge", () => {
    const html = renderToStaticMarkup(
      <AttachmentExtractionPreview
        preview={{
          fileName: "prestamo.pdf",
          result: {
            data: extractedDocumentSchema.parse({
              documentType: "balance_series",
              balances: [
                { amount: 5592, currency: "EUR", date: "2026-06-30" },
                { amount: 5401.12, currency: "EUR", date: "2026-07-31", uncertain: true },
              ],
              warnings: ["Una fila del cuadro estaba tapada."],
            }),
            status: "valid",
          },
        }}
      />,
    );

    expect(html).toContain("Lectura de prestamo.pdf");
    expect(html).toContain("2026-06-30");
    expect(html).toContain("2026-07-31");
    expect(html).toContain("Revisar lectura");
    expect(html).toContain("Una fila del cuadro estaba tapada.");
    expect(html).toContain("<table");
    // The balance series has no add-holding bridge in v1 (S5 owns the proposal).
    expect(html).not.toContain("/patrimonio/anadir");
    expect(html).not.toMatch(/Confirmar|Importar|Guardar|<form|<button/);
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
