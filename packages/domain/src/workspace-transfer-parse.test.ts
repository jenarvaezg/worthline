import { describe, expect, test } from "vitest";
import {
  serializeWorkspaceExport,
  type WorkspaceExport,
  type WorkspaceExportData,
} from "./workspace-transfer";
import { parseWorkspaceExport } from "./workspace-transfer-parse";

/** A rich, internally consistent export fixture exercising every section. */
function makeExportData(): WorkspaceExportData {
  return {
    workspace: { mode: "household", baseCurrency: "EUR" },
    members: [
      { id: "m1", name: "Alice" },
      { id: "m2", name: "Bob", disabledAt: "2026-05-01T10:00:00.000Z" },
    ],
    groups: [{ id: "g1", name: "Pareja", memberIds: ["m1"] }],
    assets: [
      {
        id: "a1",
        name: "Cuenta corriente",
        type: "cash",
        currency: "EUR",
        currentValue: { amountMinor: 150000, currency: "EUR" },
        liquidityTier: "cash",
        isPrimaryResidence: false,
        valuationMethod: "stored",
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
        valuationMethod: "derived",
        ownership: [{ memberId: "m1", shareBps: 10000 }],
        investment: {
          unitSymbol: "VWCE",
          isin: "IE00BK5BQT80",
          providerSymbol: "VWCE.DE",
          manualPricePerUnit: "111.42",
          manualPricedAt: "2026-06-01T08:00:00.000Z",
        },
      },
      {
        id: "a3",
        name: "Piso Madrid",
        type: "real_estate",
        currency: "EUR",
        currentValue: { amountMinor: 30000000, currency: "EUR" },
        liquidityTier: "illiquid",
        isPrimaryResidence: true,
        valuationMethod: "appreciating",
        annualAppreciationRate: "0.03",
        valuationAnchors: [
          {
            id: "anchor1",
            valueMinor: 28000000,
            valuationDate: "2024-01-01",
            adjustsPriorCurve: true,
          },
        ],
        ownership: [{ memberId: "m1", shareBps: 10000 }],
      },
    ],
    liabilities: [
      {
        id: "l1",
        name: "Hipoteca",
        type: "mortgage",
        currency: "EUR",
        currentBalance: { amountMinor: 12000000, currency: "EUR" },
        valuationMethod: "amortized",
        debtModel: "amortizable",
        amortizationPlan: {
          id: "plan1",
          initialCapitalMinor: 15000000,
          annualInterestRate: "0.025",
          termMonths: 360,
          disbursementDate: "2020-01-01",
          firstPaymentDate: "2020-02-01",
          interestRateRevisions: [
            { id: "rev1", revisionDate: "2023-01-01", newAnnualInterestRate: "0.031" },
          ],
          earlyRepayments: [
            {
              id: "rep1",
              repaymentDate: "2024-07-01",
              amountMinor: 2000000,
              mode: "reduce-term",
            },
          ],
        },
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
        source: "manual",
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
            countsAsHousing: false,
            holdingId: "a1",
            kind: "asset",
            label: "Cuenta corriente",
            liquidityTier: "cash",
            securesHousing: false,
            valueMinor: 150000,
          },
          {
            countsAsHousing: false,
            holdingId: "l1",
            kind: "liability",
            label: "Hipoteca",
            liquidityTier: "cash",
            securesHousing: true,
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
    connectedSources: [],
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

  test("a v3 document has no exposureProfiles section (#942)", () => {
    const document = makeDocument();

    expect("exposureProfiles" in (document as object)).toBe(false);
  });

  test("a holding's instrument survives the parse (#149)", () => {
    const document = makeDocument((doc) => {
      doc.assets[0]!.instrument = "property";
      doc.liabilities[0]!.instrument = "credit_card";
    });

    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.assets[0]!.instrument).toBe("property");
      expect(result.value.liabilities[0]!.instrument).toBe("credit_card");
    }
  });

  test("the full holding model survives the parse (#155)", () => {
    const document = makeDocument();
    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const home = result.value.assets.find((a) => a.id === "a3")!;
    expect(home.valuationMethod).toBe("appreciating");
    expect(home.annualAppreciationRate).toBe("0.03");
    expect(home.valuationAnchors).toEqual([
      {
        id: "anchor1",
        valueMinor: 28000000,
        valuationDate: "2024-01-01",
        adjustsPriorCurve: true,
      },
    ]);

    const mortgage = result.value.liabilities.find((l) => l.id === "l1")!;
    expect(mortgage.valuationMethod).toBe("amortized");
    expect(mortgage.debtModel).toBe("amortizable");
    expect(mortgage.amortizationPlan).toEqual({
      id: "plan1",
      initialCapitalMinor: 15000000,
      annualInterestRate: "0.025",
      termMonths: 360,
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      interestRateRevisions: [
        { id: "rev1", revisionDate: "2023-01-01", newAnnualInterestRate: "0.031" },
      ],
      earlyRepayments: [
        {
          id: "rep1",
          repaymentDate: "2024-07-01",
          amountMinor: 2000000,
          mode: "reduce-term",
        },
      ],
    });
  });

  test("an unknown valuation method is rejected naming the JSON path (#155)", () => {
    const document = makeDocument((doc) => {
      (doc.assets[0] as { valuationMethod: string }).valuationMethod = "vibes";
    });

    expectRejection(document, /assets\[0\]\.valuationMethod/);
  });

  test("an unknown debt model is rejected naming the JSON path (#155)", () => {
    const document = makeDocument((doc) => {
      (doc.liabilities[0] as { debtModel: string }).debtModel = "ponzi";
    });

    expectRejection(document, /liabilities\[0\]\.debtModel/);
  });

  test("a non-integer valuation-anchor amount is rejected (#155)", () => {
    const document = makeDocument((doc) => {
      doc.assets[2]!.valuationAnchors![0]!.valueMinor = 100.5;
    });

    expectRejection(document, /valuationAnchors\[0\]\.valueMinor.*entero/);
  });

  test("a minimal live-state-only document parses with absent sections normalized empty", () => {
    const result = parseWorkspaceExport({
      version: 3,
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
      expect(result.value.version).toBe(3);
      expect(result.value.groups).toEqual([]);
      expect(result.value.liabilities).toEqual([]);
      expect(result.value.operations).toEqual([]);
      expect(result.value.warningOverrides).toEqual([]);
      expect(result.value.fireConfig).toEqual({});
      expect(result.value.snapshots).toEqual([]);
      expect(result.value.trash).toEqual({ assets: [], liabilities: [] });
      expect(result.value.priceCache).toEqual([]);
      expect(result.value.publicIds).toEqual([]);
    }
  });

  // ── holding public IDs (#335): assets AND liabilities, live AND trashed ──────

  /**
   * The full, internally-consistent public-id set for the rich fixture: the
   * household scope, every member (member + scope), every group (member_group +
   * scope), and every holding (asset/liability, live + trashed) under `holding`.
   * `collectPublicIdErrors` requires the COMPLETE set once `publicIds` is
   * non-empty, so each helper case patches a copy of this.
   */
  function fullPublicIds(): WorkspaceExport["publicIds"] {
    let n = 0;
    // A unique 32-hex body per row (the import contract is ^prefix[a-f0-9]{32}$).
    const body = (): string => (n++).toString(16).padStart(32, "0");
    const mk = (entityType: string, entityId: string, prefix: string) => ({
      entityType: entityType as WorkspaceExport["publicIds"][number]["entityType"],
      entityId,
      publicId: `${prefix}${body()}`,
    });

    return [
      mk("scope", "household", "wl_scp_"),
      mk("member", "m1", "wl_mbr_"),
      mk("scope", "m1", "wl_scp_"),
      mk("member", "m2", "wl_mbr_"),
      mk("scope", "m2", "wl_scp_"),
      mk("member_group", "g1", "wl_grp_"),
      mk("scope", "g1", "wl_scp_"),
      // Holdings: live assets a1/a2/a3, trashed asset a9, live liability l1.
      mk("holding", "a1", "wl_hld_"),
      mk("holding", "a2", "wl_hld_"),
      mk("holding", "a3", "wl_hld_"),
      mk("holding", "a9", "wl_hld_"),
      mk("holding", "l1", "wl_hld_"),
    ];
  }

  test("a full public-id set including holdings (live + trashed, assets + liabilities) parses", () => {
    const document = makeDocument((doc) => {
      doc.publicIds = fullPublicIds();
    });

    const result = parseWorkspaceExport(document);

    expect(result.ok, result.ok ? "" : result.errors.join(" | ")).toBe(true);
  });

  test("a holding public id with the wrong prefix is rejected (#335)", () => {
    const document = makeDocument((doc) => {
      doc.publicIds = fullPublicIds();
      doc.publicIds.find((row) => row.entityId === "a1")!.publicId =
        "wl_scp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    });

    expectRejection(document, /publicId.*no respeta el prefijo\/formato de holding/);
  });

  test("a holding public id with a malformed body is rejected (#335)", () => {
    const document = makeDocument((doc) => {
      doc.publicIds = fullPublicIds();
      doc.publicIds.find((row) => row.entityId === "l1")!.publicId = "wl_hld_NOTHEX";
    });

    expectRejection(document, /no respeta el prefijo\/formato de holding/);
  });

  test("a holding public id targeting a holding not in the file is rejected (#335)", () => {
    const document = makeDocument((doc) => {
      doc.publicIds = [
        ...fullPublicIds(),
        {
          entityType: "holding",
          entityId: "ghost_holding",
          publicId: "wl_hld_99999999999999999999999999999999",
        },
      ];
    });

    expectRejection(document, /holding\/ghost_holding no apunta a una entidad exportada/);
  });

  test("a missing holding public id is rejected (#335)", () => {
    const document = makeDocument((doc) => {
      doc.publicIds = fullPublicIds().filter((row) => row.entityId !== "a9");
    });

    expectRejection(document, /Falta el registro publicIds holding\/a9/);
  });

  test("a duplicate holding public-id target is rejected (#335)", () => {
    const document = makeDocument((doc) => {
      const rows = fullPublicIds();
      doc.publicIds = [
        ...rows,
        {
          entityType: "holding",
          entityId: "a1",
          publicId: "wl_hld_88888888888888888888888888888888",
        },
      ];
    });

    expectRejection(document, /holding\/a1 está duplicado/);
  });

  test("public IDs must be prefixed, unique, and target exported scopes or members", () => {
    const document = makeDocument((doc) => {
      doc.publicIds = [
        {
          entityType: "scope",
          entityId: "household",
          publicId: "wl_scp_11111111111111111111111111111111",
        },
        {
          entityType: "scope",
          entityId: "m1",
          publicId: "wl_scp_22222222222222222222222222222222",
        },
        { entityType: "member", entityId: "m1", publicId: "member_m1" },
        {
          entityType: "scope",
          entityId: "ghost",
          publicId: "wl_scp_33333333333333333333333333333333",
        },
      ];
    });

    expectRejection(document, /publicIds/);
  });

  test("a snapshot with an empty holdings array is accepted (pre-ADR-0008 capture)", () => {
    const document = makeDocument((doc) => {
      doc.snapshots[0]!.holdings = [];
    });

    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(true);
  });

  test("a holding row lacking securesHousing defaults to false (pre-#180 export)", () => {
    const document = makeDocument((doc) => {
      for (const holding of doc.snapshots[0]!.holdings) {
        delete (holding as unknown as Record<string, unknown>)["securesHousing"];
      }
    });

    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const holding of result.value.snapshots[0]!.holdings) {
        expect(holding.securesHousing).toBe(false);
      }
    }
  });

  test("a holding's per-position breakdown round-trips through parse (ADR 0035)", () => {
    const document = makeDocument((doc) => {
      // a1 is worth 150000 — give it a two-row token breakdown that sums to it.
      doc.snapshots[0]!.holdings[0]!.positions = [
        {
          positionKey: "BTC:spot",
          label: "BTC",
          valueMinor: 100000,
          metal: null,
          imageUrl: null,
        },
        {
          positionKey: "ETH:spot",
          label: "ETH",
          valueMinor: 50000,
          metal: null,
          imageUrl: null,
        },
      ];
    });

    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.snapshots[0]!.holdings[0]!.positions).toEqual([
        {
          positionKey: "BTC:spot",
          label: "BTC",
          valueMinor: 100000,
          metal: null,
          imageUrl: null,
        },
        {
          positionKey: "ETH:spot",
          label: "ETH",
          valueMinor: 50000,
          metal: null,
          imageUrl: null,
        },
      ]);
    }
  });

  test("a holding without a positions field parses with positions left absent (back-compat)", () => {
    const result = parseWorkspaceExport(makeDocument());

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Absent stays undefined — never coerced to [] (an empty array would fail
      // the per-position sub-sum against the holding's nonzero value).
      expect(result.value.snapshots[0]!.holdings[0]!.positions).toBeUndefined();
    }
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

    expectRejection(document, /versión 3/);
  });

  test("a v2 export is rejected outright — no converter (#942)", () => {
    const document = makeDocument((doc) => {
      (doc as unknown as Record<string, unknown>)["version"] = 2;
    });

    expectRejection(
      document,
      "El archivo usa la versión 2; esta app solo importa la versión 3.",
    );
  });

  test("a different version is rejected naming found vs expected", () => {
    const document = makeDocument((doc) => {
      (doc as unknown as Record<string, unknown>)["version"] = 99;
    });

    expectRejection(document, /versión 99/);
    expectRejection(document, /versión 3/);
  });

  test("the lossy v1 format is rejected outright — no converter (ADR 0015)", () => {
    const document = makeDocument((doc) => {
      (doc as unknown as Record<string, unknown>)["version"] = 1;
    });

    expectRejection(document, /versión 1/);
    expectRejection(document, /versión 3/);
  });

  test("exposureProfiles in a v3 file is rejected — backups no longer carry profiles (#942)", () => {
    const document = makeDocument((doc) => {
      (doc as unknown as Record<string, unknown>).exposureProfiles = [
        { key: "IE00B3RBWM25", breakdowns: { geography: { us: "1" } } },
      ];
    });

    expectRejection(document, /exposureProfiles/);
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

  test("an unknown instrument is rejected naming the JSON path (#149)", () => {
    const document = makeDocument((doc) => {
      (doc.assets[0] as { instrument: string }).instrument = "spaceship";
    });

    expectRejection(document, /assets\[0\]\.instrument/);
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

  test("a group pointing at an unknown member is rejected before import", () => {
    const document = makeDocument((doc) => {
      doc.groups[0]!.memberIds = ["m1", "ghost"];
    });

    expectRejection(document, /grupo.*ghost/);
  });

  test("a group pointing at a disabled member is rejected before import", () => {
    const document = makeDocument((doc) => {
      doc.groups[0]!.memberIds = ["m1", "m2"];
    });

    expectRejection(document, /grupo.*m2.*inactivo/);
  });

  test("duplicate group members are rejected before hitting the DB primary key", () => {
    const document = makeDocument((doc) => {
      doc.groups[0]!.memberIds = ["m1", "m1"];
    });

    expectRejection(document, /grupo.*m1.*duplicado/);
  });

  test("duplicate ownership shares for the same member are rejected before import", () => {
    const document = makeDocument((doc) => {
      doc.assets[0]!.ownership = [
        { memberId: "m1", shareBps: 5000 },
        { memberId: "m1", shareBps: 5000 },
      ];
    });

    expectRejection(document, /titularidad.*m1.*duplicad/);
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

  test("a holding whose per-position rows do not sum to it is rejected naming the snapshot (ADR 0035)", () => {
    const document = makeDocument((doc) => {
      // a1 is worth 150000 but its breakdown sums to 100000 — the per-position
      // sub-sum (ADR 0035) must reject the snapshot, just like the headline one.
      doc.snapshots[0]!.holdings[0]!.positions = [
        {
          positionKey: "BTC:spot",
          label: "BTC",
          valueMinor: 100000,
          metal: null,
          imageUrl: null,
        },
      ];
    });

    expectRejection(document, "s1");
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

  test("operation bounds follow the same domain rules as normal entry", () => {
    const document = makeDocument((doc) => {
      doc.operations = [
        { ...doc.operations[0]!, id: "op_zero_units", units: "0" },
        { ...doc.operations[0]!, id: "op_negative_price", pricePerUnit: "-1" },
        { ...doc.operations[0]!, id: "op_negative_fees", feesMinor: -1 },
        { ...doc.operations[0]!, id: "op_bad_decimal", units: "abc" },
      ];
    });

    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors.join(" | ")).toContain("op_zero_units");
      expect(result.errors.join(" | ")).toContain("op_negative_price");
      expect(result.errors.join(" | ")).toContain("op_negative_fees");
      expect(result.errors.join(" | ")).toContain("op_bad_decimal");
    }
  });

  test("a price cache entry pointing at an asset not present in the file is rejected", () => {
    const document = makeDocument((doc) => {
      doc.priceCache[0]!.assetId = "nope";
    });

    expectRejection(document, /caché de precios/);
  });

  test("invalid investment and cached price decimals are rejected", () => {
    const document = makeDocument((doc) => {
      doc.assets[1]!.investment = { manualPricePerUnit: "-1" };
      doc.priceCache[0]!.price = "abc";
    });

    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors.join(" | ")).toContain("precio manual");
      expect(result.errors.join(" | ")).toContain("caché de precios");
    }
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
      doc.snapshots = [...doc.snapshots, { ...doc.snapshots[0]!, dateKey: "2026-06-02" }];
    });

    expectRejection(document, /instantánea.*s1/);
  });

  test("duplicate single-row DB keys are rejected before confirm import", () => {
    const document = makeDocument((doc) => {
      doc.warningOverrides = [
        { code: "ZERO_VALUE_ASSET", entityId: "a1" },
        { code: "ZERO_VALUE_ASSET", entityId: "a1" },
      ];
      doc.priceCache = [...doc.priceCache, { ...doc.priceCache[0]! }];
      doc.snapshots = [...doc.snapshots, { ...doc.snapshots[0]!, id: "s2" }];
      doc.snapshots[0]!.holdings = [
        ...doc.snapshots[0]!.holdings,
        { ...doc.snapshots[0]!.holdings[0]! },
      ];
    });

    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      const text = result.errors.join(" | ");
      expect(text).toContain("override");
      expect(text).toContain("precio");
      expect(text).toContain("scope/date");
      expect(text).toContain("posición");
    }
  });

  // ── item #2: structural id duplicate rejections (collectStructuralIdErrors) ──

  test("duplicate valuation-anchor id is rejected with Spanish boundary message (#155)", () => {
    const document = makeDocument((doc) => {
      doc.assets[2]!.valuationAnchors = [
        {
          id: "dup_anchor",
          valueMinor: 28000000,
          valuationDate: "2024-01-01",
          adjustsPriorCurve: true,
        },
        {
          id: "dup_anchor",
          valueMinor: 29000000,
          valuationDate: "2025-01-01",
          adjustsPriorCurve: false,
        },
      ];
    });
    expectRejection(document, /anclaje de valoración.*dup_anchor/);
  });

  test("duplicate amortization-plan id is rejected with Spanish boundary message (#155)", () => {
    const document = makeDocument((doc) => {
      doc.liabilities.push({
        id: "l_extra",
        name: "Extra",
        type: "debt",
        currency: "EUR",
        currentBalance: { amountMinor: 1000, currency: "EUR" },
        ownership: [{ memberId: "m1", shareBps: 10000 }],
        valuationMethod: "amortized",
        debtModel: "amortizable",
        amortizationPlan: {
          id: "plan1",
          initialCapitalMinor: 5000,
          annualInterestRate: "0.02",
          termMonths: 12,
          disbursementDate: "2024-01-01",
          firstPaymentDate: "2024-02-01",
          interestRateRevisions: [],
          earlyRepayments: [],
        },
      });
    });
    expectRejection(document, /plan de amortización.*plan1/);
  });

  test("duplicate interest-rate-revision id is rejected with Spanish boundary message (#155)", () => {
    const document = makeDocument((doc) => {
      doc.liabilities[0]!.amortizationPlan!.interestRateRevisions = [
        { id: "dup_rev", revisionDate: "2022-01-01", newAnnualInterestRate: "0.03" },
        { id: "dup_rev", revisionDate: "2023-01-01", newAnnualInterestRate: "0.04" },
      ];
    });
    expectRejection(document, /revisión de tipo.*dup_rev/);
  });

  test("duplicate early-repayment id is rejected with Spanish boundary message (#155)", () => {
    const document = makeDocument((doc) => {
      doc.liabilities[0]!.amortizationPlan!.earlyRepayments = [
        {
          id: "dup_rep",
          repaymentDate: "2023-06-01",
          amountMinor: 100000,
          mode: "reduce-term",
        },
        {
          id: "dup_rep",
          repaymentDate: "2024-06-01",
          amountMinor: 200000,
          mode: "reduce-term",
        },
      ];
    });
    expectRejection(document, /amortización anticipada.*dup_rep/);
  });

  test("duplicate balance-anchor id is rejected with Spanish boundary message (#155)", () => {
    const document = makeDocument((doc) => {
      doc.liabilities[0]!.balanceAnchors = [
        { id: "dup_banc", balanceMinor: 100000, anchorDate: "2023-01-01" },
        { id: "dup_banc", balanceMinor: 90000, anchorDate: "2024-01-01" },
      ];
    });
    expectRejection(document, /anclaje de saldo.*dup_banc/);
  });

  // ── item #2: non-numeric decimal strings in rate fields ──────────────────────

  test("a non-numeric annualAppreciationRate is rejected (#155)", () => {
    const document = makeDocument((doc) => {
      (doc.assets[2] as { annualAppreciationRate: string }).annualAppreciationRate =
        "abc";
    });
    expectRejection(document, /decimal válido/);
  });

  test("a non-numeric plan annualInterestRate is rejected (#155)", () => {
    const document = makeDocument((doc) => {
      doc.liabilities[0]!.amortizationPlan!.annualInterestRate = "abc";
    });
    expectRejection(document, /decimal válido/);
  });

  test("a non-numeric revision newAnnualInterestRate is rejected (#155)", () => {
    const document = makeDocument((doc) => {
      doc.liabilities[0]!.amortizationPlan!
        .interestRateRevisions[0]!.newAnnualInterestRate = "abc";
    });
    expectRejection(document, /decimal válido/);
  });

  // ── item #3: composite (entity,date) uniqueness validation ───────────────────

  test("two valuation anchors on the same asset+date with distinct ids are rejected (#155)", () => {
    const document = makeDocument((doc) => {
      doc.assets[2]!.valuationAnchors = [
        {
          id: "va1",
          valueMinor: 28000000,
          valuationDate: "2024-01-01",
          adjustsPriorCurve: true,
        },
        {
          id: "va2",
          valueMinor: 29000000,
          valuationDate: "2024-01-01",
          adjustsPriorCurve: false,
        },
      ];
    });
    expectRejection(document, /anclaje.*fecha/i);
  });

  test("two valuation anchors on the same asset but distinct dates pass (#155)", () => {
    const document = makeDocument((doc) => {
      doc.assets[2]!.valuationAnchors = [
        {
          id: "va1",
          valueMinor: 28000000,
          valuationDate: "2024-01-01",
          adjustsPriorCurve: true,
        },
        {
          id: "va2",
          valueMinor: 29000000,
          valuationDate: "2025-01-01",
          adjustsPriorCurve: false,
        },
      ];
    });
    const result = parseWorkspaceExport(document);
    expect(result.ok).toBe(true);
  });

  test("two interest-rate revisions on the same plan+date with distinct ids are rejected (#155)", () => {
    const document = makeDocument((doc) => {
      doc.liabilities[0]!.amortizationPlan!.interestRateRevisions = [
        { id: "r1", revisionDate: "2022-06-01", newAnnualInterestRate: "0.03" },
        { id: "r2", revisionDate: "2022-06-01", newAnnualInterestRate: "0.04" },
      ];
    });
    expectRejection(document, /revisión.*fecha/i);
  });

  test("two early repayments on the same plan+date with distinct ids are rejected (#155)", () => {
    const document = makeDocument((doc) => {
      doc.liabilities[0]!.amortizationPlan!.earlyRepayments = [
        {
          id: "e1",
          repaymentDate: "2023-06-01",
          amountMinor: 100000,
          mode: "reduce-term",
        },
        {
          id: "e2",
          repaymentDate: "2023-06-01",
          amountMinor: 200000,
          mode: "reduce-term",
        },
      ];
    });
    expectRejection(document, /amortización.*fecha/i);
  });

  test("two balance anchors on the same liability+date with distinct ids are rejected (#155)", () => {
    const document = makeDocument((doc) => {
      doc.liabilities[0]!.balanceAnchors = [
        { id: "b1", balanceMinor: 100000, anchorDate: "2023-01-01" },
        { id: "b2", balanceMinor: 90000, anchorDate: "2023-01-01" },
      ];
    });
    expectRejection(document, /anclaje.*saldo.*fecha/i);
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

describe("parseWorkspaceExport — connected sources (ADR 0016)", () => {
  /** A coin_collection asset + a numista source projecting into it, with a coin. */
  function withConnectedSource(doc: WorkspaceExport): void {
    doc.assets.push({
      id: "coins",
      name: "Colección Numista",
      type: "manual",
      currency: "EUR",
      currentValue: { amountMinor: 12_500, currency: "EUR" },
      liquidityTier: "illiquid",
      instrument: "coin_collection",
      valuationMethod: "derived",
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
    });
    doc.connectedSources = [
      {
        id: "src1",
        adapter: "numista",
        label: "Colección Numista",
        assetId: "coins",
        lastSyncAt: "2026-06-10T18:00:00.000Z",
        positions: [
          {
            kind: "coin",
            id: "p1",
            externalId: "ext-1",
            catalogueId: "n1",
            issueId: null,
            name: "8 reales",
            grade: "VF",
            quantity: 1,
            year: 1888,
            liquidityTier: "illiquid",
            metal: "silver",
            finenessMillis: null,
            weightGrams: null,
            purchaseDate: "2024-01-01",
            metalValueMinor: null,
            numismaticValueMinor: null,
            numismaticFetchedAt: null,
            purchasePriceMinor: 5_000,
            obverseThumbUrl: "https://en.numista.com/catalogue/photos/x/n1-180.jpg",
            currency: "EUR",
          },
        ],
      },
    ];
  }

  test("a coin_collection holding + its source and positions parse", () => {
    const document = makeDocument(withConnectedSource);
    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.connectedSources).toHaveLength(1);
      expect(result.value.connectedSources[0]!.positions).toHaveLength(1);
      // The coin's obverse photo round-trips through export/import (#272 x100).
      expect(result.value.connectedSources[0]!.positions[0]).toMatchObject({
        obverseThumbUrl: "https://en.numista.com/catalogue/photos/x/n1-180.jpg",
      });
    }
  });

  test("a position from a pre-gallery file defaults its obverse thumbnail to null", () => {
    const document = makeDocument((doc) => {
      withConnectedSource(doc);
      // A file written before the gallery existed carries no obverseThumbUrl.
      delete (doc.connectedSources[0]!.positions[0] as { obverseThumbUrl?: unknown })
        .obverseThumbUrl;
    });

    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.connectedSources[0]!.positions[0]).toMatchObject({
        obverseThumbUrl: null,
      });
    }
  });

  test("a source projecting into a missing asset is rejected", () => {
    const document = makeDocument((doc) => {
      withConnectedSource(doc);
      doc.connectedSources[0]!.assetId = "ghost";
    });
    expectRejection(document, /fuente conectada.*activo inexistente/i);
  });

  test("two positions sharing an id under one source are rejected", () => {
    const document = makeDocument((doc) => {
      withConnectedSource(doc);
      doc.connectedSources[0]!.positions.push({
        ...doc.connectedSources[0]!.positions[0]!,
        externalId: "ext-2",
      });
    });
    expectRejection(document, /posición de la fuente/i);
  });
});

describe("parseWorkspaceExport — FireScopeConfig N3 fields", () => {
  test("FireScopeConfig without expectedRealReturn (weighted mode) round-trips", () => {
    const document = makeDocument((doc) => {
      doc.fireConfig["household"] = {
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.04,
        // no expectedRealReturn — weighted tier mode
      };
    });

    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cfg = result.value.fireConfig["household"]!;
    expect(cfg.expectedRealReturn).toBeUndefined();
  });

  test("FireScopeConfig with tierRealReturns round-trips", () => {
    const document = makeDocument((doc) => {
      doc.fireConfig["household"] = {
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.04,
        tierRealReturns: { cash: 0.0, market: 0.06, "term-locked": 0.02, illiquid: 0.04 },
      };
    });

    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cfg = result.value.fireConfig["household"]!;
    expect(cfg.tierRealReturns).toEqual({
      cash: 0.0,
      market: 0.06,
      "term-locked": 0.02,
      illiquid: 0.04,
    });
    expect(cfg.expectedRealReturn).toBeUndefined();
  });

  test("FireScopeConfig N1/N2 fields (leanMultiplier, fatMultiplier, baristaMonthlyIncomeMinor) round-trip", () => {
    const document = makeDocument((doc) => {
      doc.fireConfig["household"] = {
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.05,
        leanMultiplier: 0.7,
        fatMultiplier: 1.5,
        baristaMonthlyIncomeMinor: 50_000,
      };
    });

    const result = parseWorkspaceExport(document);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cfg = result.value.fireConfig["household"]!;
    expect(cfg.leanMultiplier).toBe(0.7);
    expect(cfg.fatMultiplier).toBe(1.5);
    expect(cfg.baristaMonthlyIncomeMinor).toBe(50_000);
  });
});

describe("parseWorkspaceExport — payouts referential integrity (PRD #652)", () => {
  test("rejects a payout whose holdingId is not an exported asset", () => {
    expectRejection(
      makeDocument((doc) => {
        doc.payouts = [
          { id: "pay1", holdingId: "ghost", dateISO: "2025-06-01", amountMinor: 1000 },
        ];
      }),
      /El cobro pay1 referencia un activo inexistente: ghost/,
    );
  });

  test("rejects a payout attached to a liability id (income is asset-side)", () => {
    expectRejection(
      makeDocument((doc) => {
        doc.payouts = [
          { id: "pay1", holdingId: "l1", dateISO: "2025-06-01", amountMinor: 1000 },
        ];
      }),
      /activo inexistente: l1/,
    );
  });

  test("rejects a schedule whose holdingId is not an exported asset", () => {
    expectRejection(
      makeDocument((doc) => {
        doc.payoutSchedules = [
          {
            id: "sch1",
            holdingId: "ghost",
            label: "Alquiler",
            amountMinor: 100000,
            cadence: "monthly",
            startISO: "2024-01-01",
            endISO: null,
            exclusions: [],
          },
        ];
      }),
      /cobro recurrente.*activo inexistente: ghost/,
    );
  });

  test("rejects duplicate payout ids", () => {
    expectRejection(
      makeDocument((doc) => {
        doc.payouts = [
          { id: "dup", holdingId: "a1", dateISO: "2025-06-01", amountMinor: 1000 },
          { id: "dup", holdingId: "a1", dateISO: "2025-07-01", amountMinor: 1000 },
        ];
      }),
      /Id de cobro duplicado: dup/,
    );
  });

  test("rejects a non-positive schedule amount (income-only)", () => {
    expectRejection(
      makeDocument((doc) => {
        doc.payoutSchedules = [
          {
            id: "s9",
            holdingId: "a1",
            label: "X",
            amountMinor: 0,
            cadence: "monthly",
            startISO: "2024-01-01",
            endISO: null,
            exclusions: [],
          },
        ];
      }),
      /importe no positivo/,
    );
  });

  test("accepts a payout + schedule that reference a live asset", () => {
    const result = parseWorkspaceExport(
      makeDocument((doc) => {
        doc.payouts = [
          { id: "pay1", holdingId: "a1", dateISO: "2025-06-01", amountMinor: 1000 },
        ];
        doc.payoutSchedules = [
          {
            id: "sch1",
            holdingId: "a1",
            label: "Alquiler",
            amountMinor: 100000,
            cadence: "monthly",
            startISO: "2024-01-01",
            endISO: null,
            exclusions: [],
          },
        ];
      }),
    );
    expect(result.ok).toBe(true);
  });
});
