import type { MatchPortfolioHolding } from "@worthline/domain";
import { describe, expect, it } from "vitest";
import type { ExtractedPositionsMovementsDocument } from "./attachment-extraction-contract";
import {
  buildReconcileRows,
  discardReconcileRow,
  effectiveDecision,
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
    expect(rows[0]!.movementsCount).toBe(2);
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
