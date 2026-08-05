import { describe, expect, it } from "vitest";

import {
  type ExtractedDocument,
  type ExtractedPositionsMovementsDocument,
  extractedDocumentSchema,
} from "./attachment-extraction-contract";
import {
  positionsMovementsInContext,
  resolveReconcileDocument,
} from "./reconcile-document-frontier";

/**
 * The frontier of #1373: `propose_reconcile` says it is a document lane, and now it
 * IS one. The session that opened the issue is the case under test — a MyInvestor
 * aportación confirmation, no positions/movements document anywhere, and a model
 * that typed the name of the OTHER pension plan of the workspace into the row plus a
 * `value` copied from the portfolio snapshot.
 */

/**
 * The plan's own ISIN as the EXTRACTOR can carry it. The DGS code the paper prints
 * («N5394») is not a valid ISIN, so the contract's `isinSchema` refuses it — which is
 * itself part of why the real case had nothing but a name to go on.
 */
const SP500 = "ES0173516115";

const DOCUMENT: ExtractedPositionsMovementsDocument = {
  documentType: "positions_movements",
  holdings: [
    {
      name: "MYINVESTOR INDEXADO SP 500 PP",
      type: "Plan de pensiones",
      isin: SP500,
      value: 5508.68,
      currency: "EUR",
      fidelity: "movements",
    },
    {
      name: "Amundi MSCI World",
      type: "Fondo",
      isin: "LU1681043599",
      value: 12_000,
      currency: "EUR",
      fidelity: "value_only",
    },
  ],
  movements: [
    {
      date: "2026-08-05",
      kind: "contribution",
      isin: SP500,
      units: 5.92,
      amount: 125,
      currency: "EUR",
    },
  ],
  warnings: [],
};

/** The branded «worthline validated this» document, as the extractor produces it. */
function validated(document: unknown): ExtractedDocument {
  return extractedDocumentSchema.parse(document);
}

describe("positionsMovementsInContext", () => {
  it("finds nothing in a turn whose only document is another kind", () => {
    const holdingEvent = validated({
      documentType: "holding_event",
      event: {
        kind: "deposit",
        amount: 125,
        currency: "EUR",
        date: "2026-08-05",
        label: "APORTACION P.P.",
      },
      warnings: [],
    });

    expect(positionsMovementsInContext([holdingEvent])).toBeNull();
  });

  it("takes the LAST one when a conversation uploaded two", () => {
    const first = validated({ ...DOCUMENT, holdings: [DOCUMENT.holdings[1]!] });
    const second = validated(DOCUMENT);

    expect(positionsMovementsInContext([first, second])?.holdings).toHaveLength(2);
  });
});

describe("resolveReconcileDocument", () => {
  it("refuses the call when no validated positions document is in play (#1373)", () => {
    const result = resolveReconcileDocument(
      [{ name: "MyInvestor Indexado SP500", value: 5387 }],
      null,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe("reconcile_document_required");
    // It ROUTES: the two real lanes are named, and neither is «I type the row».
    expect(result.error.message).toContain("importar-extracto");
    expect(result.error.message).toContain("operación puntual");
  });

  it("rejects a row the document does not contain, naming what it does contain", () => {
    // The exact invention of the issue: the workspace's OTHER pension plan.
    const result = resolveReconcileDocument(
      [{ name: "N5396 - Myinvestor Indexado Global PP", value: 5387 }],
      DOCUMENT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe("reconcile_row_not_in_document");
    expect(result.error.message).toContain("N5396 - Myinvestor Indexado Global PP");
    expect(result.error.message).toContain("MYINVESTOR INDEXADO SP 500 PP");
  });

  it("rejects the batch whole — never silently shrunk to the rows that matched", () => {
    const result = resolveReconcileDocument(
      [{ name: "Amundi MSCI World" }, { name: "Un fondo que no está" }],
      DOCUMENT,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a value that disagrees with the document, even on the right row", () => {
    const result = resolveReconcileDocument(
      [{ name: "MYINVESTOR INDEXADO SP 500 PP", value: 5387 }],
      DOCUMENT,
    );

    expect(result.ok).toBe(false);
  });

  it("takes the row the model points at, with the DOCUMENT's own figures", () => {
    const result = resolveReconcileDocument(
      // Loosely typed, as a model relays it: different case, spacing, no value.
      [{ name: "  myinvestor indexado sp 500 pp  " }],
      DOCUMENT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.holdings).toEqual([DOCUMENT.holdings[0]]);
    expect(result.document.holdings[0]!.value).toBe(5508.68);
    // The movements travel whole: they are the extractor's, keyed per holding later.
    expect(result.document.movements).toEqual(DOCUMENT.movements);
  });

  it("matches by ISIN when the model relays a name of its own", () => {
    const result = resolveReconcileDocument(
      [{ name: "Plan de pensiones MyInvestor", isin: "es0173516115" }],
      DOCUMENT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.holdings[0]!.name).toBe("MYINVESTOR INDEXADO SP 500 PP");
  });

  it("tolerates a whole-euro relay of a figure with cents", () => {
    expect(
      resolveReconcileDocument(
        [{ name: "MYINVESTOR INDEXADO SP 500 PP", value: 5509 }],
        DOCUMENT,
      ).ok,
    ).toBe(true);
  });

  it("no claims at all means the whole document", () => {
    const result = resolveReconcileDocument([], DOCUMENT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.holdings).toHaveLength(2);
  });

  it("keeps document order and deduplicates a row named twice", () => {
    const result = resolveReconcileDocument(
      [
        { name: "Amundi MSCI World" },
        { name: "MYINVESTOR INDEXADO SP 500 PP" },
        { isin: "LU1681043599" },
      ],
      DOCUMENT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.holdings.map((holding) => holding.name)).toEqual([
      "MYINVESTOR INDEXADO SP 500 PP",
      "Amundi MSCI World",
    ]);
  });
});
