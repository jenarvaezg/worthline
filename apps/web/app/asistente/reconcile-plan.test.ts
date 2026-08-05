import { countKeyClaimants, type MatchPortfolioHolding } from "@worthline/domain";
import { describe, expect, it } from "vitest";
import type { ExtractedPositionsMovementsDocument } from "./attachment-extraction-contract";
import {
  buildReconcileRows,
  discardReconcileRow,
  effectiveDecision,
  isRowWritable,
  reassignRowToCandidate,
  reassignRowToNew,
  reconcileImpact,
  reconcileSummary,
  restoreReconcileRow,
} from "./reconcile-plan";

function doc(
  overrides: Partial<ExtractedPositionsMovementsDocument> = {},
): ExtractedPositionsMovementsDocument {
  return {
    documentType: "positions_movements",
    holdings: [],
    movements: [],
    warnings: [],
    ...overrides,
  };
}

const AMUNDI = "LU1681043599";
const VANGUARD = "IE00B3RBWM25";

describe("buildReconcileRows", () => {
  it("resolves a strong ISIN hit to update and a miss to create", () => {
    const document = doc({
      holdings: [
        {
          name: "Amundi MSCI World",
          type: "Fondo",
          isin: AMUNDI,
          value: 12000,
          currency: "EUR",
          fidelity: "value_only",
        },
        {
          name: "Vanguard Global",
          type: "ETF",
          isin: VANGUARD,
          value: 5000,
          currency: "EUR",
          fidelity: "value_only",
        },
      ],
    });
    const portfolio: MatchPortfolioHolding[] = [
      {
        holdingId: "asset-amundi",
        name: "Amundi MSCI World",
        isin: AMUNDI,
        instrument: "fund",
      },
    ];

    const rows = buildReconcileRows(document, portfolio);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.match.decision).toBe("update");
    expect(rows[0]!.match.target).toBe("asset-amundi");
    expect(rows[0]!.instrument).toBe("fund");
    expect(rows[0]!.valueMinor).toBe(1_200_000);
    expect(rows[1]!.match.decision).toBe("create");
    expect(rows[1]!.instrument).toBe("etf");
  });

  it("counts movements linked to each holding and stamps the fidelity tier", () => {
    const document = doc({
      holdings: [
        {
          name: "Amundi MSCI World",
          type: "Fondo",
          isin: AMUNDI,
          value: 12000,
          currency: "EUR",
          fidelity: "movements",
        },
      ],
      movements: [
        { date: "2025-01-10", kind: "buy", isin: AMUNDI, amount: 6000, currency: "EUR" },
        { date: "2025-06-10", kind: "buy", isin: AMUNDI, amount: 6000, currency: "EUR" },
      ],
    });
    const rows = buildReconcileRows(document, []);
    expect(rows[0]!.movements).toHaveLength(2);
    expect(rows[0]!.fidelity).toBe("movements");
  });

  it("marks an unmapped type and a non-EUR value uncertain without blocking", () => {
    const document = doc({
      holdings: [
        {
          name: "Cosa rara",
          type: "no-lo-se",
          value: 100,
          currency: "EUR",
          fidelity: "value_only",
        },
        {
          name: "US Fund",
          type: "Fondo",
          value: 100,
          currency: "USD",
          fidelity: "value_only",
        },
      ],
    });
    const rows = buildReconcileRows(document, []);
    expect(rows[0]!.instrument).toBeNull();
    expect(rows[0]!.uncertain).toBe(true);
    expect(rows[1]!.uncertain).toBe(true);
    // Uncertain never forces a decision: both are still create (no portfolio).
    expect(rows.every((row) => row.match.decision === "create")).toBe(true);
  });
});

describe("buildReconcileRows — el mismo fondo en dos brokers (#1331)", () => {
  // The real workspace case: the ISIN lives in a CLOSED position of an old portfolio
  // and in the LIVE holding of the Cartera Indexada that keeps receiving
  // contributions. The document's movements belong to the live one, and the row must
  // never claim to have resolved that on its own.
  const SHARED = "IE00B1G3DH73";
  const document = doc({
    holdings: [
      {
        name: "Vanguard US Equity Index Fund EUR Hedged",
        type: "Fondo",
        isin: SHARED,
        value: 15000,
        currency: "EUR",
        fidelity: "movements",
      },
    ],
    movements: [
      {
        date: "2026-01-10",
        kind: "buy",
        isin: SHARED,
        units: 10,
        amount: 1000,
        currency: "EUR",
      },
    ],
  });
  const portfolio: MatchPortfolioHolding[] = [
    {
      holdingId: "asset-closed",
      name: "Vanguard U.S. 500 Stk Idx € H Acc",
      isin: SHARED,
      instrument: "fund",
      closed: true,
    },
    {
      holdingId: "asset-live",
      name: "Vanguard US Equity Index Fund EUR Hedged",
      isin: SHARED,
      instrument: "fund",
    },
  ];

  it("never resolves the shared ISIN as strong — it goes to review with both candidates", () => {
    const [row] = buildReconcileRows(document, portfolio);
    expect(row!.match.confidence).toBe("weak");
    expect(row!.match.confidence).not.toBe("strong");
    expect(row!.match.ambiguous).toBe(true);
    expect(row!.match.candidates.map((candidate) => candidate.holdingId)).toEqual([
      "asset-live",
      "asset-closed",
    ]);
    expect(countKeyClaimants(row!.match)).toBe(2);
  });

  it("defaults to the live holding, so the contributions never land on the closed one", () => {
    const [row] = buildReconcileRows(document, portfolio);
    expect(row!.match.target).toBe("asset-live");
    expect(row!.movements).toHaveLength(1);
    // It still writes: review means "check which one", not "drop the row".
    expect(isRowWritable(row!)).toBe(true);
  });

  it("reassigning to the other candidate resolves the review", () => {
    const rows = reassignRowToCandidate(
      buildReconcileRows(document, portfolio),
      "row-0",
      "asset-closed",
    );
    expect(rows[0]!.match.target).toBe("asset-closed");
    expect(rows[0]!.match.ambiguous).toBeUndefined();
  });

  it("a uniquely held ISIN keeps resolving strong", () => {
    const [row] = buildReconcileRows(document, [portfolio[1]!]);
    expect(row!.match.confidence).toBe("strong");
    expect(row!.match.ambiguous).toBeUndefined();
    expect(countKeyClaimants(row!.match)).toBe(1);
  });
});

/**
 * The MyInvestor aportación of #1373: ONE holding already in the portfolio, ONE
 * movement of 125,00 € (5,92 participaciones), and a header that read `+0 €`.
 *
 * The ISIN is the plan's real one, not the DGS code the paper prints («N5394», which
 * is what the workspace happens to have stored): the extraction contract refuses a
 * non-ISIN, so a document can only ever identify the plan by this.
 */
const SP500 = "ES0173516115";

function aportacionDocument(): ExtractedPositionsMovementsDocument {
  return doc({
    holdings: [
      {
        name: "MYINVESTOR INDEXADO SP 500 PP",
        type: "Plan de pensiones",
        isin: SP500,
        value: 5508.68,
        currency: "EUR",
        fidelity: "movements",
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
  });
}

const SP500_PORTFOLIO: MatchPortfolioHolding[] = [
  {
    holdingId: "asset-sp500",
    name: "MyInvestor Indexado SP500",
    isin: SP500,
    instrument: "pension_plan",
  },
];

describe("buildReconcileRows — la evidencia viaja en la fila (#1373)", () => {
  it("carries date, kind, units, unit price and signed amount of each movement", () => {
    const [row] = buildReconcileRows(aportacionDocument(), SP500_PORTFOLIO);

    expect(row!.movements).toEqual([
      {
        currency: "EUR",
        date: "2026-08-05",
        kind: "contribution",
        signedAmountMinor: 12_500,
        unitPrice: 125 / 5.92,
        units: 5.92,
      },
    ]);
    expect(row!.movementsDeltaMinor).toBe(12_500);
  });

  it("signs by kind, not by the sign the document used", () => {
    const rows = buildReconcileRows(
      doc({
        holdings: [
          {
            name: "Fondo",
            type: "Fondo",
            isin: AMUNDI,
            value: 100,
            currency: "EUR",
            fidelity: "movements",
          },
        ],
        movements: [
          { date: "2026-01-02", kind: "buy", isin: AMUNDI, amount: 300, currency: "EUR" },
          // The same withdrawal, stated negative by one sheet and positive by another.
          {
            date: "2026-02-02",
            kind: "sell",
            isin: AMUNDI,
            amount: -100,
            currency: "EUR",
          },
          {
            date: "2026-03-02",
            kind: "sell",
            isin: AMUNDI,
            amount: 100,
            currency: "EUR",
          },
        ],
      }),
      [],
    );

    expect(rows[0]!.movements.map((movement) => movement.signedAmountMinor)).toEqual([
      30_000, -10_000, -10_000,
    ]);
    expect(rows[0]!.movementsDeltaMinor).toBe(10_000);
  });

  it("leaves a movement in another currency out of the row's sum", () => {
    const rows = buildReconcileRows(
      doc({
        holdings: [
          {
            name: "Fondo",
            type: "Fondo",
            isin: AMUNDI,
            value: 100,
            currency: "EUR",
            fidelity: "movements",
          },
        ],
        movements: [
          { date: "2026-01-02", kind: "buy", isin: AMUNDI, amount: 100, currency: "EUR" },
          { date: "2026-02-02", kind: "buy", isin: AMUNDI, amount: 900, currency: "USD" },
        ],
      }),
      [],
    );

    expect(rows[0]!.movements).toHaveLength(2);
    expect(rows[0]!.movementsDeltaMinor).toBe(10_000);
  });
});

describe("editing (immutable)", () => {
  const document = doc({
    holdings: [
      {
        name: "Amundi MSCI World",
        type: "Fondo",
        isin: AMUNDI,
        value: 12000,
        currency: "EUR",
        fidelity: "value_only",
      },
    ],
  });
  const portfolio: MatchPortfolioHolding[] = [
    {
      holdingId: "asset-amundi",
      name: "Amundi MSCI World",
      isin: AMUNDI,
      instrument: "fund",
    },
  ];

  it("reassigns a matched row to create and keeps the candidate as a duplicate warning", () => {
    const rows = buildReconcileRows(document, portfolio);
    const next = reassignRowToNew(rows, "row-0");
    expect(next[0]!.match.decision).toBe("create");
    expect(next[0]!.match.possibleDuplicate?.holdingId).toBe("asset-amundi");
    // Original is untouched (immutability).
    expect(rows[0]!.match.decision).toBe("update");
  });

  it("reassigns back to a named candidate", () => {
    const rows = reassignRowToNew(buildReconcileRows(document, portfolio), "row-0");
    const next = reassignRowToCandidate(rows, "row-0", "asset-amundi");
    expect(next[0]!.match.decision).toBe("update");
    expect(next[0]!.match.target).toBe("asset-amundi");
  });

  it("discards and restores a row", () => {
    const rows = buildReconcileRows(document, portfolio);
    const discarded = discardReconcileRow(rows, "row-0");
    expect(discarded[0]!.excluded).toBe(true);
    expect(effectiveDecision(discarded[0]!)).toBe("leave");
    const restored = restoreReconcileRow(discarded, "row-0");
    expect(restored[0]!.excluded).toBe(false);
    expect(effectiveDecision(restored[0]!)).toBe("update");
  });
});

describe("reconcileSummary", () => {
  it("counts create/update/leave with exclusions", () => {
    const document = doc({
      holdings: [
        {
          name: "A",
          type: "Fondo",
          isin: AMUNDI,
          value: 1,
          currency: "EUR",
          fidelity: "value_only",
        },
        { name: "New", type: "ETF", value: 1, currency: "EUR", fidelity: "value_only" },
        {
          name: "Discarded",
          type: "ETF",
          value: 1,
          currency: "EUR",
          fidelity: "value_only",
        },
      ],
    });
    const portfolio: MatchPortfolioHolding[] = [
      { holdingId: "asset-a", name: "A", isin: AMUNDI, instrument: "fund" },
    ];
    const rows = discardReconcileRow(buildReconcileRows(document, portfolio), "row-2");
    // "A" matches by ISIN but is value_only with no movements → an update that does
    // not write, so `active` counts only the created "New".
    expect(reconcileSummary(rows)).toEqual({
      active: 1,
      create: 1,
      leave: 1,
      total: 3,
      update: 1,
    });
  });
});

describe("reconcileImpact", () => {
  it("adds the value of every writable created investment holding", () => {
    const document = doc({
      holdings: [
        {
          name: "Fund",
          type: "Fondo",
          value: 1000,
          currency: "EUR",
          fidelity: "value_only",
        },
        { name: "Etf", type: "ETF", value: 500, currency: "EUR", fidelity: "value_only" },
      ],
    });
    const rows = buildReconcileRows(document, []);
    const impact = reconcileImpact(rows, 10_000_00);
    // +100000 (fund) +50000 (etf) = +150000.
    expect(impact.deltaMinor).toBe(150_000);
    expect(impact.beforeMinor).toBe(1_000_000);
    expect(impact.afterMinor).toBe(1_150_000);
    expect(impact.partial).toBe(false);
  });

  it("excludes an out-of-scope (non-investment) create from the delta and flags partial", () => {
    const document = doc({
      holdings: [
        {
          name: "Fund",
          type: "Fondo",
          value: 1000,
          currency: "EUR",
          fidelity: "value_only",
        },
        {
          name: "Casa",
          type: "Inmueble",
          value: 500,
          currency: "EUR",
          fidelity: "value_only",
        },
      ],
    });
    const rows = buildReconcileRows(document, []);
    const impact = reconcileImpact(rows, 0);
    expect(impact.deltaMinor).toBe(100_000);
    expect(impact.partial).toBe(true);
  });

  it("flags partial when an update or a non-EUR create is present, excluding it", () => {
    const document = doc({
      holdings: [
        {
          name: "Fund",
          type: "Fondo",
          isin: AMUNDI,
          value: 1000,
          currency: "EUR",
          fidelity: "value_only",
        },
        {
          name: "US",
          type: "Fondo",
          value: 999,
          currency: "USD",
          fidelity: "value_only",
        },
      ],
    });
    const portfolio: MatchPortfolioHolding[] = [
      { holdingId: "asset-a", name: "Fund", isin: AMUNDI, instrument: "fund" },
    ];
    const rows = buildReconcileRows(document, portfolio);
    const impact = reconcileImpact(rows, 0);
    // row-0 is an update (excluded from delta), row-1 is a non-EUR create (excluded).
    expect(impact.deltaMinor).toBe(0);
    expect(impact.partial).toBe(true);
  });

  /**
   * The regression of #1373. `Patrimonio neto 297.060 € → 297.060 €` and `+0 €` over
   * a document that says +125 €: the user's own words were «debería ser +125 no +0
   * no?». The movement-backed update is summed now, and the caption stops naming
   * altas a batch that has none.
   */
  it("sums a movement-backed update instead of showing +0 € (#1373)", () => {
    const rows = buildReconcileRows(aportacionDocument(), SP500_PORTFOLIO);
    const impact = reconcileImpact(rows, 297_060_00);

    expect(rows[0]!.match.decision).toBe("update");
    expect(impact.deltaMinor).toBe(12_500);
    expect(impact.afterMinor).toBe(297_185_00);
    expect(impact.includesMovements).toBe(true);
    expect(impact.includesCreates).toBe(false);
    // Nothing is missing from the sum: the estimate mark comes from the ripple, not
    // from a row left out (that is what the caption distinguishes).
    expect(impact.partial).toBe(false);
  });

  it("a sale in the batch subtracts", () => {
    const document = doc({
      holdings: [
        {
          name: "Fondo",
          type: "Fondo",
          isin: AMUNDI,
          value: 1000,
          currency: "EUR",
          fidelity: "movements",
        },
      ],
      movements: [
        { date: "2026-03-01", kind: "sell", isin: AMUNDI, amount: 400, currency: "EUR" },
      ],
    });
    const portfolio: MatchPortfolioHolding[] = [
      { holdingId: "asset-a", name: "Fondo", isin: AMUNDI, instrument: "fund" },
    ];

    expect(reconcileImpact(buildReconcileRows(document, portfolio), 0).deltaMinor).toBe(
      -40_000,
    );
  });

  it("flags partial when a linked movement is in a currency it cannot sum", () => {
    const document = doc({
      holdings: [
        {
          name: "Fondo",
          type: "Fondo",
          isin: AMUNDI,
          value: 1000,
          currency: "EUR",
          fidelity: "movements",
        },
      ],
      movements: [
        { date: "2026-03-01", kind: "buy", isin: AMUNDI, amount: 100, currency: "EUR" },
        { date: "2026-04-01", kind: "buy", isin: AMUNDI, amount: 900, currency: "USD" },
      ],
    });
    const portfolio: MatchPortfolioHolding[] = [
      { holdingId: "asset-a", name: "Fondo", isin: AMUNDI, instrument: "fund" },
    ];
    const impact = reconcileImpact(buildReconcileRows(document, portfolio), 0);

    expect(impact.deltaMinor).toBe(10_000);
    expect(impact.partial).toBe(true);
  });

  it("an excluded row contributes nothing, movements or not", () => {
    const rows = discardReconcileRow(
      buildReconcileRows(aportacionDocument(), SP500_PORTFOLIO),
      "row-0",
    );
    const impact = reconcileImpact(rows, 297_060_00);

    expect(impact.deltaMinor).toBe(0);
    expect(impact.includesMovements).toBe(false);
    expect(impact.partial).toBe(false);
  });

  it("returns null after when the before read degraded", () => {
    const rows = buildReconcileRows(
      doc({
        holdings: [
          {
            name: "F",
            type: "Fondo",
            value: 10,
            currency: "EUR",
            fidelity: "value_only",
          },
        ],
      }),
      [],
    );
    const impact = reconcileImpact(rows, null);
    expect(impact.beforeMinor).toBeNull();
    expect(impact.afterMinor).toBeNull();
    expect(impact.deltaMinor).toBe(1000);
  });
});
