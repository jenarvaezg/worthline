import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { extractedDocumentSchema } from "./attachment-extraction-contract";
import AttachmentExtractionPreview from "./attachment-extraction-preview";

describe("AttachmentExtractionPreview", () => {
  test("shows every position, total, uncertainty and warnings before any bridge", () => {
    const html = renderToStaticMarkup(
      <AttachmentExtractionPreview
        card={{
          kind: "parsed",
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

  test("paints a value-only row as a reading, not as a hole (#1325)", () => {
    const html = renderToStaticMarkup(
      <AttachmentExtractionPreview
        card={{
          kind: "parsed",
          fileName: "composicion.png",
          result: {
            data: extractedDocumentSchema.parse({
              documentType: "positions",
              positions: [
                {
                  currency: "EUR",
                  marketValueEur: 574.48,
                  name: "Fondo Índice Metal",
                },
              ],
              totalEur: 574.48,
              warnings: [],
            }),
            status: "valid",
          },
        }}
      />,
    );

    // The name carries the row on its own: no stray separator where a ticker was.
    expect(html).toContain("Fondo Índice Metal");
    expect(html).not.toContain("· Fondo Índice Metal");
    expect(html).not.toContain("undefined");
    // The empty column says «the document printed none», and the hint says what the
    // alta will therefore do — 1 participación at that value (#1325).
    expect(html).toContain("—");
    expect(html).toContain("sin participaciones");
    // And the bridge still works: this is the row the widening exists to carry through.
    expect(html).toContain("name_fund=Fondo+%C3%8Dndice+Metal");
    expect(html).not.toContain("symbol_fund");
    expect(html).toContain("price_fund=574.48");
  });

  test("shows a dated balance series with uncertainty, warnings and no wizard bridge", () => {
    const html = renderToStaticMarkup(
      <AttachmentExtractionPreview
        card={{
          kind: "parsed",
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
    // Nothing here is dated after the turn, so the forecast copy stays off the card.
    expect(html).not.toContain("Previsión");
  });

  test("says which rows of a schedule are the document's forecast, not a reading", () => {
    // #1424: la marca NO es «revisar lectura» — la cifra está transcrita exacta. Es lo
    // que la fila SIGNIFICA: un saldo de 2034 es lo que el banco proyecta.
    const html = renderToStaticMarkup(
      <AttachmentExtractionPreview
        card={{
          kind: "parsed",
          fileName: "cuadro.xlsx",
          result: {
            data: extractedDocumentSchema.parse({
              documentType: "balance_series",
              balances: [
                { amount: 52857.24, currency: "EUR", date: "2026-06-01" },
                {
                  amount: 46985.97,
                  currency: "EUR",
                  date: "2027-06-01",
                  projected: true,
                },
              ],
              warnings: [],
            }),
            status: "valid",
          },
        }}
      />,
    );

    expect(html).toContain("Previsión");
    expect(html).toContain("no saldos observados");
    // La duda de lectura es otra cosa y no debe aparecer por esta puerta.
    expect(html).not.toContain("Revisar lectura");
  });

  test("shows the dated fact, its verbatim label and the effect the screen declared", () => {
    const html = renderToStaticMarkup(
      <AttachmentExtractionPreview
        card={{
          kind: "parsed",
          fileName: "pago.png",
          result: {
            data: extractedDocumentSchema.parse({
              documentType: "holding_event",
              event: {
                date: "2026-07-26",
                amount: 91.32,
                currency: "EUR",
                // Deliberately NOT the wording of the `kind` label: an assertion on
                // "Amortización anticipada" would pass with `label` rendered as the
                // empty string, since the kind map produces that same phrase.
                label: "Pago único al préstamo",
                kind: "early_repayment",
                declaredEffect: {
                  kind: "final_instalment_reduced",
                  amount: 110.64,
                  currency: "EUR",
                },
                nextInstalment: { date: "2026-08-08", amount: 158.49, currency: "EUR" },
              },
              warnings: ["El concepto se lee con dificultad."],
            }),
            status: "valid",
          },
        }}
      />,
    );

    expect(html).toContain("Lectura de pago.png");
    expect(html).toContain("26/07/2026");
    expect(html).toContain("91,32");
    // The screen's own words survive the reading — that is the point of `label`.
    expect(html).toContain("Pago único al préstamo");
    // …and the model's classification is shown as ours, not as something the screen
    // said: an amount under an authoritative «Amortización anticipada» the document
    // never wrote is the invention ADR 0048 forbids.
    expect(html).toContain("Amortización anticipada");
    expect(html).toContain("«Tipo» es una clasificación de la lectura");
    expect(html).toContain("110,64");
    expect(html).toContain("08/08/2026");
    expect(html).toContain("158,49");
    expect(html).toContain("El concepto se lee con dificultad.");
    // Nothing is written from the card, and the card adds no figure of its own to
    // the four the document carried (ADR 0048): no principal, no term, no rate, no
    // resulting balance. Pinned as an exact figure set rather than by keyword,
    // because a *declared* effect may legitimately say «saldo» when the screen did.
    expect(html).not.toMatch(/Confirmar|Importar|Guardar|<form|<button/);
    expect(html.match(/\d+,\d\d/g)).toEqual(["91,32", "110,64", "158,49"]);
    expect(html).not.toContain("/patrimonio/anadir");
  });

  test("shows the bare observation without inventing the optional context", () => {
    const html = renderToStaticMarkup(
      <AttachmentExtractionPreview
        card={{
          kind: "parsed",
          fileName: "recibo.jpg",
          result: {
            data: extractedDocumentSchema.parse({
              documentType: "holding_event",
              event: {
                date: "2026-07-08",
                amount: 158.49,
                currency: "EUR",
                label: "Cuota mensual",
                kind: "payment",
                uncertain: true,
              },
              // A reading the extractor itself doubted as a whole must say so on the
              // card; the document-level flag is otherwise invisible to the user.
              uncertain: true,
              warnings: [],
            }),
            status: "valid",
          },
        }}
      />,
    );

    expect(html).toContain("Cuota mensual");
    expect(html).toContain("Revisar lectura");
    expect(html).toContain("Lectura completa marcada como dudosa.");
    expect(html).not.toContain("Efecto declarado");
    expect(html).not.toContain("Próxima cuota");
    // A receipt prints no instrument identity (#1316) and the card must invent no row
    // for it — an empty «ISIN» or «Títulos» would read as «no consta».
    expect(html).not.toContain("ISIN");
    expect(html).not.toContain("Títulos");
    expect(html).not.toContain("Precio por título");
    expect(html).not.toContain("Comisión");
  });

  test("shows the instrument identity a trade confirmation printed (#1316)", () => {
    const html = renderToStaticMarkup(
      <AttachmentExtractionPreview
        card={{
          kind: "parsed",
          fileName: "confirmacion.pdf",
          result: {
            data: extractedDocumentSchema.parse({
              documentType: "holding_event",
              event: {
                date: "2026-07-24",
                amount: 1004.6,
                currency: "EUR",
                label: "Compra VANGUARD GLOBAL STOCK INDEX FUND",
                // `other` on purpose: its label is «Movimiento», so no assertion
                // below can pass on the strength of the kind row's wording.
                kind: "other",
                isin: "IE00B03HCZ61",
                units: 62.3418,
                pricePerUnit: { amount: 16.0184, currency: "EUR" },
                fees: { amount: 1.5, currency: "EUR" },
              },
              warnings: [],
            }),
            status: "valid",
          },
        }}
      />,
    );

    // The user CONFIRMS this card, so every field the contract carried is on it.
    expect(html).toContain('<th scope="row">ISIN</th><td>IE00B03HCZ61</td>');
    expect(html).toContain("62,3418");
    expect(html).toContain("1,50");
    expect(html).toContain("1004,60");
    expect(html).toContain("Compra VANGUARD GLOBAL STOCK INDEX FUND");
    // The unit price keeps the four decimals the paper printed: rounded to 16,02 €
    // the card would be showing a figure the document never stated.
    expect(html).toContain("16,0184");
    expect(html).not.toContain("16,02");
    // And the card still computes nothing of its own — no units × price total beside
    // the settled amount, which is the derivation the contract forbids.
    expect(html).not.toContain("998,60");
    expect(html).not.toMatch(/Confirmar|Importar|Guardar|<form|<button/);
  });

  test("renders typed nonfatal failures honestly", () => {
    const html = renderToStaticMarkup(
      <AttachmentExtractionPreview
        card={{
          kind: "parsed",
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

  /**
   * The card is the ONLY surface telling the user what worthline read of their
   * document, so a payload written by a newer server must still paint something in a
   * tab that predates the deploy (#1261) — the failure this replaces was the card
   * silently not being there at all.
   */
  test("paints a degraded card rather than nothing at all (#1261)", () => {
    const html = renderToStaticMarkup(
      <AttachmentExtractionPreview
        card={{
          fileName: "captura.png",
          kind: "degraded",
          message: "No reconozco en este archivo ninguno de los documentos que sé leer.",
        }}
      />,
    );

    expect(html).toContain("Lectura de captura.png");
    expect(html).toContain(
      "No reconozco en este archivo ninguno de los documentos que sé leer.",
    );
    expect(html).toContain('role="status"');
  });
});
