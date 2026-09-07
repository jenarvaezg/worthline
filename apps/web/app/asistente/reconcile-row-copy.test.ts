import { describe, expect, it } from "vitest";

import type { ReconcileImpact, ReconcileRow } from "./reconcile-plan";
import {
  reconcileDestinationLabel,
  reconcileDocumentLine,
  reconcileImpactCaption,
  reconcileMatchCaveat,
  reconcileMovementLine,
} from "./reconcile-row-copy";

/**
 * The four sentences the reconcile card was getting wrong (#1373), pinned one by
 * one. The literal case of the issue is the MyInvestor aportación: `05/08/2026 ·
 * aportación · 5,92 part. × 21,1149 € · 125 €` (the issue writes «compra», the
 * operation the confirm persists; the line prints the document's own word, which is
 * what the user compares it against), over a header that must not say «estimado
 * sobre las altas» in a batch with no altas at all.
 */

/**
 * `Intl` separates a figure from its currency with a non-breaking space, which is
 * correct on screen and unreadable in an expectation. Normalized here so the
 * assertions state the whole sentence — and so a change of separator never reads as
 * a change of copy.
 */
function plain(value: string): string {
  return value.replace(/[  ]/g, " ");
}

function row(overrides: Partial<ReconcileRow> = {}): ReconcileRow {
  return {
    currency: "EUR",
    excluded: false,
    fidelity: "movements",
    instrument: "pension_plan",
    match: {
      candidates: [
        { holdingId: "asset-sp500", name: "MyInvestor Indexado SP500", key: "isin" },
      ],
      confidence: "strong",
      decision: "update",
      key: "isin",
      rowId: "row-0",
      target: "asset-sp500",
    },
    movements: [],
    movementsDeltaMinor: 0,
    name: "MYINVESTOR INDEXADO SP 500 PP",
    rowId: "row-0",
    securityId: { kind: "isin", value: "ES0173516115" },
    uncertain: false,
    valueMinor: 550_868,
    ...overrides,
  } as ReconcileRow;
}

function impact(overrides: Partial<ReconcileImpact> = {}): ReconcileImpact {
  return {
    afterMinor: 0,
    beforeMinor: 0,
    deltaMinor: 0,
    includesCreates: false,
    includesMovements: false,
    partial: false,
    ...overrides,
  };
}

describe("reconcileMovementLine", () => {
  it("prints the aportación of the issue in full", () => {
    expect(
      plain(
        reconcileMovementLine({
          currency: "EUR",
          date: "2026-08-05",
          kind: "contribution",
          signedAmountMinor: 12_500,
          unitPrice: 125 / 5.92,
          units: 5.92,
        }),
      ),
    ).toBe("05/08/2026 · aportación · 5,92 part. × 21,1149 € · 125 €");
  });

  it("omits participaciones when the document brought none", () => {
    expect(
      plain(
        reconcileMovementLine({
          currency: "EUR",
          date: "2026-01-31",
          kind: "buy",
          signedAmountMinor: 20_050,
        }),
      ),
    ).toBe("31/01/2026 · compra · 200,50 €");
  });

  it("prints a sale as its own kind, never as a negative amount", () => {
    expect(
      plain(
        reconcileMovementLine({
          currency: "EUR",
          date: "2026-03-02",
          kind: "sell",
          signedAmountMinor: -40_000,
        }),
      ),
    ).toBe("02/03/2026 · venta · 400 €");
  });

  it("says a movement it cannot write is out of scope, in its own currency", () => {
    expect(
      reconcileMovementLine({
        currency: "USD",
        date: "2026-03-02",
        kind: "buy",
        signedAmountMinor: 90_000,
      }),
    ).toContain("fuera de alcance");
  });
});

describe("reconcileDocumentLine / reconcileDestinationLabel", () => {
  it("separates what the document says from where it will be written (#1373)", () => {
    const target = row();

    expect(reconcileDocumentLine(target)).toBe(
      "MYINVESTOR INDEXADO SP 500 PP · ES0173516115",
    );
    expect(reconcileDestinationLabel(target)).toBe(
      "Actualizar «MyInvestor Indexado SP500»",
    );
  });

  it("names the document's own text when the row creates", () => {
    const created = row({
      match: {
        candidates: [],
        confidence: "none",
        decision: "create",
        key: "name",
        rowId: "row-0",
      } as ReconcileRow["match"],
    });

    expect(reconcileDestinationLabel(created)).toBe(
      "Crear «MYINVESTOR INDEXADO SP 500 PP»",
    );
  });

  it("an excluded row leaves, whatever its match said", () => {
    expect(reconcileDestinationLabel(row({ excluded: true }))).toBe("Dejar");
  });
});

describe("reconcileImpactCaption", () => {
  it("stops naming altas in a batch that has none", () => {
    const caption = reconcileImpactCaption(impact({ includesMovements: true }));

    expect(caption).toBe("estimado sobre los movimientos");
    expect(caption).not.toContain("altas");
  });

  it("names both sources when the batch has both", () => {
    expect(
      reconcileImpactCaption(impact({ includesCreates: true, includesMovements: true })),
    ).toBe("estimado sobre las altas y los movimientos");
  });

  it("a batch of altas alone is exact — no estimate mark", () => {
    expect(reconcileImpactCaption(impact({ includesCreates: true }))).toBe(
      "sobre las altas",
    );
  });

  it("marks the estimate when something is left out of the sum", () => {
    expect(reconcileImpactCaption(impact({ includesCreates: true, partial: true }))).toBe(
      "estimado sobre las altas",
    );
    expect(reconcileImpactCaption(impact({ partial: true }))).toBe("estimado");
  });

  it("says nothing at all when there is nothing to qualify", () => {
    expect(reconcileImpactCaption(impact())).toBe("");
  });
});

/**
 * The weak match stops disguising itself as a strong one (#1747). A row matched only
 * by name is the failure mode of #1373 in its purest form — the model relayed a name
 * and the card presented a confident destination — and until now the review mark
 * appeared only when SEVERAL holdings shared the name. One is the dangerous case.
 */
describe("reconcileMatchCaveat — el match por nombre se declara (#1747)", () => {
  const byName = (over: Partial<ReconcileRow["match"]> = {}): ReconcileRow =>
    row({
      match: {
        candidates: [
          { confidence: "weak", holdingId: "asset-otro", key: "name", name: "El otro" },
        ],
        confidence: "weak",
        decision: "update",
        key: "name",
        rowId: "row-0",
        target: "asset-otro",
        ...over,
      } as ReconcileRow["match"],
    });

  it("marca un match por nombre de un solo candidato", () => {
    expect(reconcileMatchCaveat(byName())).toBe(
      " · emparejado solo por nombre — revisa el destino",
    );
  });

  it("cuando varios comparten el nombre, dice cuántos", () => {
    const several = byName({
      ambiguous: true,
      candidates: [
        { confidence: "weak", holdingId: "asset-otro", key: "name", name: "El otro" },
        { confidence: "weak", holdingId: "asset-mas", key: "name", name: "El otro" },
      ],
    });

    expect(reconcileMatchCaveat(several)).toBe(
      " · 2 holdings con el mismo nombre: revisa cuál actualizas",
    );
  });

  it("un match fuerte por identificador no lleva marca", () => {
    expect(reconcileMatchCaveat(row())).toBe("");
  });

  it("una fila descartada no pide revisar nada", () => {
    expect(reconcileMatchCaveat(byName())).not.toBe("");
    expect(reconcileMatchCaveat({ ...byName(), excluded: true })).toBe("");
  });
});

/** El plan de pensiones se nombra por su código DGS, no por un ISIN (#1747). */
describe("reconcileDocumentLine — el identificador tipado", () => {
  it("imprime el código DGS de un plan igual que imprimiría un ISIN", () => {
    expect(
      reconcileDocumentLine(row({ securityId: { kind: "dgs", value: "N5394" } })),
    ).toBe("MYINVESTOR INDEXADO SP 500 PP · N5394");
  });

  it("sin identificador, solo el nombre", () => {
    const { securityId: _omitted, ...bare } = row();
    expect(reconcileDocumentLine(bare as ReconcileRow)).toBe(
      "MYINVESTOR INDEXADO SP 500 PP",
    );
  });
});
