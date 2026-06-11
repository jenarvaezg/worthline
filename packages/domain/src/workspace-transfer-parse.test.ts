import { describe, expect, test } from "vitest";

import { parseWorkspaceExport } from "./workspace-transfer-parse";
import {
  serializeWorkspaceExport,
  type WorkspaceExport,
  type WorkspaceExportData,
} from "./workspace-transfer";

/** A rich, internally consistent export fixture exercising every section. */
function makeExportData(): WorkspaceExportData {
  return {
    workspace: { mode: "household", baseCurrency: "EUR" },
    members: [
      { id: "m1", name: "Alice" },
      { id: "m2", name: "Bob", disabledAt: "2026-05-01T10:00:00.000Z" },
    ],
    groups: [{ id: "g1", name: "Pareja", memberIds: ["m1", "m2"] }],
    assets: [
      {
        id: "a1",
        name: "Cuenta corriente",
        type: "cash",
        currency: "EUR",
        currentValue: { amountMinor: 150000, currency: "EUR" },
        liquidityTier: "cash",
        isPrimaryResidence: false,
        ownership: [
          { memberId: "m1", shareBps: 5000 },
          { memberId: "m2", shareBps: 5000 },
        ],
      },
      {
        id: "a2",
        name: "Fondo indexado",
        type: "investment",
        currency: "EUR",
        liquidityTier: "market",
        ownership: [{ memberId: "m1", shareBps: 10000 }],
        investment: {
          unitSymbol: "VWCE",
          isin: "IE00BK5BQT80",
          providerSymbol: "VWCE.DE",
          manualPricePerUnit: "111.42",
          manualPricedAt: "2026-06-01T08:00:00.000Z",
        },
      },
    ],
    liabilities: [
      {
        id: "l1",
        name: "Hipoteca",
        type: "mortgage",
        currency: "EUR",
        currentBalance: { amountMinor: 12000000, currency: "EUR" },
        ownership: [
          { memberId: "m1", shareBps: 5000 },
          { memberId: "m2", shareBps: 5000 },
        ],
        associatedAssetId: "a1",
      },
    ],
    operations: [
      {
        id: "op1",
        assetId: "a2",
        kind: "buy",
        executedAt: "2026-05-15T09:30:00.000Z",
        units: "10.5",
        pricePerUnit: "100.25",
        currency: "EUR",
        feesMinor: 150,
      },
    ],
    warningOverrides: [{ code: "ZERO_VALUE_ASSET", entityId: "a1" }],
    fireConfig: {
      household: {
        monthlySpendingMinor: 250000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.05,
      },
    },
    snapshots: [
      {
        id: "s1",
        scopeId: "household",
        scopeLabel: "Hogar",
        capturedAt: "2026-06-01T20:00:00.000Z",
        dateKey: "2026-06-01",
        monthKey: "2026-06",
        isMonthlyClose: false,
        totalNetWorth: { amountMinor: 130000, currency: "EUR" },
        liquidNetWorth: { amountMinor: 130000, currency: "EUR" },
        housingEquity: { amountMinor: 0, currency: "EUR" },
        grossAssets: { amountMinor: 150000, currency: "EUR" },
        debts: { amountMinor: 20000, currency: "EUR" },
        warnings: [],
        holdings: [
          {
            holdingId: "a1",
            kind: "asset",
            label: "Cuenta corriente",
            liquidityTier: "cash",
            valueMinor: 150000,
          },
          {
            holdingId: "l1",
            kind: "liability",
            label: "Hipoteca",
            liquidityTier: "cash",
            valueMinor: 20000,
          },
        ],
      },
    ],
    trash: {
      assets: [
        {
          id: "a9",
          name: "Coche viejo",
          type: "manual",
          currency: "EUR",
          currentValue: { amountMinor: 300000, currency: "EUR" },
          liquidityTier: "illiquid",
          ownership: [{ memberId: "m1", shareBps: 10000 }],
          deletedAt: "2026-05-20T12:00:00.000Z",
        },
      ],
      liabilities: [],
    },
    priceCache: [
      {
        assetId: "a2",
        currency: "EUR",
        price: "111.42",
        source: "stooq",
        priceDate: "2026-06-10",
        fetchedAt: "2026-06-10T18:00:00.000Z",
        freshnessState: "fresh",
      },
    ],
  };
}

/** A serialized + JSON-round-tripped document, optionally patched. */
function makeDocument(patch?: (doc: WorkspaceExport) => void): unknown {
  const doc = JSON.parse(
    JSON.stringify(serializeWorkspaceExport(makeExportData())),
  ) as WorkspaceExport;

  patch?.(doc);

  return doc;
}

function expectRejection(input: unknown, fragment: string | RegExp): void {
  const result = parseWorkspaceExport(input);

  expect(result.ok).toBe(false);

  if (result.ok) return;

  expect(result.errors.length).toBeGreaterThan(0);

  const matched = result.errors.some((error) =>
    typeof fragment === "string" ? error.includes(fragment) : fragment.test(error),
  );

  expect(
    matched,
    `no error matched ${String(fragment)} — got: ${result.errors.join(" | ")}`,
  ).toBe(true);
}

describe("parseWorkspaceExport — acceptance", () => {
  test("a serialized document round-trips through JSON and parses unchanged", () => {
    const document = makeDocument();
    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value).toEqual(document);
    }
  });

  test("a minimal live-state-only document parses with absent sections normalized empty", () => {
    const result = parseWorkspaceExport({
      version: 1,
      workspace: { mode: "individual", baseCurrency: "EUR" },
      members: [{ id: "m1", name: "Alice" }],
      assets: [
        {
          id: "a1",
          name: "Cuenta",
          type: "cash",
          currency: "EUR",
          currentValue: { amountMinor: 5000, currency: "EUR" },
          liquidityTier: "cash",
          ownership: [{ memberId: "m1", shareBps: 10000 }],
        },
      ],
    });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value.version).toBe(1);
      expect(result.value.groups).toEqual([]);
      expect(result.value.liabilities).toEqual([]);
      expect(result.value.operations).toEqual([]);
      expect(result.value.warningOverrides).toEqual([]);
      expect(result.value.fireConfig).toEqual({});
      expect(result.value.snapshots).toEqual([]);
      expect(result.value.trash).toEqual({ assets: [], liabilities: [] });
      expect(result.value.priceCache).toEqual([]);
    }
  });

  test("a snapshot with an empty holdings array is accepted (pre-ADR-0008 capture)", () => {
    const document = makeDocument((doc) => {
      doc.snapshots[0]!.holdings = [];
    });

    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(true);
  });

  test("unknown extra keys are tolerated and stripped", () => {
    const document = makeDocument((doc) => {
      (doc as unknown as Record<string, unknown>)["auditLog"] = [{ id: "x" }];
      (doc.members[0] as unknown as Record<string, unknown>)["nickname"] = "Ali";
    });

    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect("auditLog" in result.value).toBe(false);
      expect("nickname" in result.value.members[0]!).toBe(false);
    }
  });
});

describe("parseWorkspaceExport — input shape and version", () => {
  test("null input rejects cleanly", () => {
    expectRejection(null, /objeto/);
  });

  test("string input rejects cleanly", () => {
    expectRejection("not a document", /objeto/);
  });

  test("a missing version is rejected with the expected version named", () => {
    const document = makeDocument((doc) => {
      delete (doc as Partial<WorkspaceExport>).version;
    });

    expectRejection(document, /versión 1/);
  });

  test("a different version is rejected naming found vs expected", () => {
    const document = makeDocument((doc) => {
      (doc as unknown as Record<string, unknown>)["version"] = 99;
    });

    expectRejection(document, /versión 99/);
    expectRejection(document, /versión 1/);
  });
});

describe("parseWorkspaceExport — structure", () => {
  test("an empty members array is rejected", () => {
    const document = makeDocument((doc) => {
      doc.members = [];
    });

    expectRejection(document, "members");
  });

  test("a non-integer money amount is rejected naming the JSON path", () => {
    const document = makeDocument((doc) => {
      doc.assets[0]!.currentValue = { amountMinor: 100.5, currency: "EUR" };
    });

    expectRejection(document, /assets\[0\]\.currentValue\.amountMinor.*entero/);
  });

  test("an empty id string is rejected naming the JSON path", () => {
    const document = makeDocument((doc) => {
      doc.members[0]!.id = "";
    });

    expectRejection(document, /members\[0\]\.id/);
  });
});

describe("parseWorkspaceExport — domain invariants", () => {
  test("baseCurrency other than EUR is rejected", () => {
    const document = makeDocument((doc) => {
      doc.workspace.baseCurrency = "USD";
    });

    expectRejection(document, "EUR");
  });

  test("a live asset whose ownership split does not total 10000 bps is rejected", () => {
    const document = makeDocument((doc) => {
      doc.assets[0]!.ownership = [{ memberId: "m1", shareBps: 9000 }];
    });

    expectRejection(document, /9000/);
    expectRejection(document, /10000/);
  });

  test("a trashed asset whose ownership split does not total 10000 bps is rejected", () => {
    const document = makeDocument((doc) => {
      doc.trash.assets[0]!.ownership = [{ memberId: "m1", shareBps: 1 }];
    });

    expectRejection(document, "a9");
  });

  test("a liability whose ownership split does not total 10000 bps is rejected", () => {
    const document = makeDocument((doc) => {
      doc.liabilities[0]!.ownership = [{ memberId: "m1", shareBps: 12000 }];
    });

    expectRejection(document, /12000/);
  });

  test("an ownership share pointing at an unknown member is rejected", () => {
    const document = makeDocument((doc) => {
      doc.assets[0]!.ownership = [{ memberId: "ghost", shareBps: 10000 }];
    });

    expectRejection(document, "ghost");
  });

  test("an investment asset carrying currentValue is rejected (ADR 0006)", () => {
    const document = makeDocument((doc) => {
      doc.assets[1]!.currentValue = { amountMinor: 5000, currency: "EUR" };
    });

    expectRejection(document, "a2");
  });

  test("a non-investment asset missing currentValue is rejected", () => {
    const document = makeDocument((doc) => {
      delete doc.assets[0]!.currentValue;
    });

    expectRejection(document, "a1");
  });

  test("investment metadata on a non-investment asset is rejected", () => {
    const document = makeDocument((doc) => {
      doc.assets[0]!.investment = { unitSymbol: "XX" };
    });

    expectRejection(document, /metadatos de inversión/);
  });

  test("a snapshot whose holdings do not reconcile is rejected naming the snapshot (ADR 0008)", () => {
    const document = makeDocument((doc) => {
      doc.snapshots[0]!.holdings[0]!.valueMinor = 1;
    });

    expectRejection(document, "s1");
  });

  test("a liability associated with an asset not present in the file is rejected", () => {
    const document = makeDocument((doc) => {
      doc.liabilities[0]!.associatedAssetId = "nope";
    });

    expectRejection(document, "nope");
  });

  test("an operation pointing at an asset not present in the file is rejected", () => {
    const document = makeDocument((doc) => {
      doc.operations[0]!.assetId = "nope";
    });

    expectRejection(document, "op1");
  });

  test("an operation pointing at a non-investment asset is rejected", () => {
    const document = makeDocument((doc) => {
      doc.operations[0]!.assetId = "a1";
    });

    expectRejection(document, /no es de inversión/);
  });

  test("a price cache entry pointing at an asset not present in the file is rejected", () => {
    const document = makeDocument((doc) => {
      doc.priceCache[0]!.assetId = "nope";
    });

    expectRejection(document, /caché de precios/);
  });

  test("duplicate member ids are rejected", () => {
    const document = makeDocument((doc) => {
      doc.members = [
        { id: "m1", name: "Alice" },
        { id: "m1", name: "Alicia" },
      ];
    });

    expectRejection(document, /miembro.*m1/);
  });

  test("duplicate group ids are rejected", () => {
    const document = makeDocument((doc) => {
      doc.groups = [
        { id: "g1", name: "Pareja", memberIds: ["m1"] },
        { id: "g1", name: "Otra", memberIds: ["m2"] },
      ];
    });

    expectRejection(document, /grupo.*g1/);
  });

  test("an asset id duplicated between live and trash is rejected", () => {
    const document = makeDocument((doc) => {
      doc.trash.assets[0]!.id = "a1";
    });

    expectRejection(document, /activo.*a1/);
  });

  test("duplicate liability ids are rejected", () => {
    const document = makeDocument((doc) => {
      doc.trash.liabilities = [
        {
          id: "l1",
          name: "Hipoteca duplicada",
          type: "mortgage",
          currency: "EUR",
          currentBalance: { amountMinor: 100, currency: "EUR" },
          ownership: [{ memberId: "m1", shareBps: 10000 }],
          deletedAt: "2026-05-20T12:00:00.000Z",
        },
      ];
    });

    expectRejection(document, /pasivo.*l1/);
  });

  test("duplicate operation ids are rejected", () => {
    const document = makeDocument((doc) => {
      doc.operations = [...doc.operations, { ...doc.operations[0]! }];
    });

    expectRejection(document, /operación.*op1/);
  });

  test("duplicate snapshot ids are rejected", () => {
    const document = makeDocument((doc) => {
      doc.snapshots = [
        ...doc.snapshots,
        { ...doc.snapshots[0]!, dateKey: "2026-06-02" },
      ];
    });

    expectRejection(document, /instantánea.*s1/);
  });

  test("multiple independent violations are all collected", () => {
    const document = makeDocument((doc) => {
      doc.workspace.baseCurrency = "USD";
      doc.assets[0]!.ownership = [{ memberId: "m1", shareBps: 9000 }];
      doc.priceCache[0]!.assetId = "nope";
    });

    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});
