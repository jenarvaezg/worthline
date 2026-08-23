import type {
  DomainWarning,
  HoldingReturnsView,
  PortfolioGroup,
  PriceSource,
  UnifiedHolding,
} from "@worthline/domain";
import { buildHoldingReturnsView, money, signedMinor } from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import BalanceBoard from "./balance-board";

const EUR = "EUR";

function assetRow(
  id: string,
  name: string,
  valueMinor: number,
  opts: {
    tier?: UnifiedHolding["tier"];
    tierLabel?: string;
    derived?: boolean;
    shareBps?: number;
    priceFetchedAt?: string | null;
    priceSource?: PriceSource | null;
  } = {},
): UnifiedHolding {
  return {
    direction: "asset",
    id,
    name,
    valueMinor,
    tier: opts.tier ?? "market",
    tierLabel: opts.tierLabel ?? "Mercado",
    instrument: "fund",
    valueIsDerived: opts.derived ?? false,
    priceFetchedAt: opts.priceFetchedAt ?? null,
    priceSource: opts.priceSource ?? null,
    ownership: { shares: [], totalShareBps: opts.shareBps ?? 10_000 },
  };
}

function liabilityRow(
  id: string,
  name: string,
  balanceMinor: number,
  opts: { tier?: UnifiedHolding["tier"]; tierLabel?: string } = {},
): UnifiedHolding {
  return {
    direction: "liability",
    id,
    name,
    balanceMinor,
    tier: opts.tier ?? "housing",
    tierLabel: opts.tierLabel ?? "Vivienda",
    instrument: "mortgage",
    ownership: { shares: [], totalShareBps: 10_000 },
  };
}

function group(
  key: string,
  label: string,
  amountMinor: number,
  holdings: UnifiedHolding[],
): PortfolioGroup {
  return {
    holdings,
    key,
    label,
    totalMinor: { amountMinor, currency: EUR },
    units: holdings.map((holding) => ({
      holding,
      key: holding.id,
      kind: "holding" as const,
      signedMinor: signedMinor(holding),
    })),
  };
}

/** A rung-grouped portfolio: a Mercado section (2 derived assets) and a Vivienda
 *  section holding both the home (asset) and the mortgage (liability). */
function fixtureGroups(): PortfolioGroup[] {
  return [
    group("market", "Mercado", 30_000_00, [
      assetRow("a_small", "Accion Pequena", 5_000_00, { derived: true }),
      assetRow("a_big", "Fondo Grande", 25_000_00, { derived: true }),
    ]),
    group("housing", "Vivienda", 180_000_00, [
      assetRow("a_home", "Casa Familiar", 300_000_00, {
        tier: "housing",
        tierLabel: "Vivienda",
        shareBps: 6_000,
      }),
      liabilityRow("l_mort", "Hipoteca", 120_000_00),
    ]),
  ];
}

const emptyTrash = { assets: [], liabilities: [] };

/**
 * Every rendered holding's public `wl_hld_…` id — the only id the board is
 * allowed to put in a URL (#1318). Derived from whatever groups a case renders
 * so a new fixture holding is registered by construction, never silently
 * unlinked.
 */
function publicIdsFor(groups: PortfolioGroup[]): Record<string, string> {
  return Object.fromEntries(
    groups.flatMap((g) => g.holdings.map((h) => [h.id, `wl_hld_${h.id}`])),
  );
}

function render(props: Partial<Parameters<typeof BalanceBoard>[0]> = {}) {
  const groups = props.groups ?? fixtureGroups();
  return renderToStaticMarkup(
    <BalanceBoard
      currentUrl="/patrimonio"
      isHousehold={false}
      nowIso="2026-06-10T12:00:00.000Z"
      privacyMode={false}
      trash={emptyTrash}
      warnings={[]}
      {...props}
      groups={groups}
      publicIdByHolding={props.publicIdByHolding ?? publicIdsFor(groups)}
    />,
  );
}

function marketReturns(
  totalGainMinor: number,
  totalReturnRatio: number,
): HoldingReturnsView {
  return buildHoldingReturnsView({
    instrument: "fund",
    irr: { rate: 0.082, reason: null },
    simpleGain: {
      annualized: true,
      cagr: 0.1,
      spanDays: 800,
      totalGain: money(totalGainMinor, "EUR"),
      totalInvestedMinor: Math.round(totalGainMinor / totalReturnRatio),
      totalReturnRatio,
    },
  })!;
}

describe("BalanceBoard returns (#551)", () => {
  test("shows the per-holding simple gain inline, with the hover measures", () => {
    const html = render({
      returnsById: new Map([["a_big", marketReturns(5_039_00, 0.299)]]),
    });

    expect(html).toContain("+29,9 %");
    // es-ES omits the grouping separator for 4-digit integers → "5039" (NBSP + €).
    expect(html).toContain("5039");
    // The hover explains the three measures + honest caveats.
    expect(html).toContain("IRR anual: +8,2 %");
    expect(html).toContain("No incluye dividendos ni cupones.");
  });

  test("scales the € gain to the row's scope share (percentage stays share-invariant)", () => {
    // a_home is 60%-owned (shareBps 6000); a 300.000 full gain shows as 180.000.
    const html = render({
      returnsById: new Map([["a_home", marketReturns(300_000_00, 0.25)]]),
    });

    expect(html).toContain("180.000");
    expect(html).toContain("+25,0 %");
  });

  test("holdings without a returns view show no inline gain", () => {
    const html = render();
    expect(html).not.toContain("returnsHint");
  });

  // #1275: the row is tabbable, so focusing it must say what it is. On a bare
  // <div> (implicit role `generic`) the aria-label is not mapped at all — the
  // hint took focus and announced nothing.
  test("the tabbable returns hint carries a role that maps its label", () => {
    const html = render({
      returnsById: new Map([["a_big", marketReturns(5_039_00, 0.299)]]),
    });

    const hint = /<div[^>]*class="balanceRowReturns[^>]*>/.exec(html)?.[0] ?? "";
    expect(hint).toContain('tabindex="0"');
    expect(hint).toContain('role="group"');
    expect(hint).toContain('aria-label="Rentabilidad:');
  });
});

describe("BalanceBoard (#271)", () => {
  test("splits assets and liabilities into the two panes and reconciles the net", () => {
    const html = render();

    expect(html).toContain("Activos");
    expect(html).toContain("Pasivos");
    // Assets land in their pane; the mortgage on the liability side.
    expect(html).toContain("Fondo Grande");
    expect(html).toContain("Casa Familiar");
    expect(html).toContain("Hipoteca");
    // Reconciliation: 330.000 activos - 120.000 pasivos = 210.000 neto.
    expect(html).toContain("Balance");
    expect(html).toContain("Patrimonio neto");
    expect(html).toContain("330.000");
    expect(html).toContain("210.000");
  });

  test("orders holdings within a section by amount, largest first", () => {
    const html = render();
    // "Fondo Grande" (25.000) must render before "Accion Pequena" (5.000).
    expect(html.indexOf("Fondo Grande")).toBeLessThan(html.indexOf("Accion Pequena"));
  });

  test("marks a derived value with a marker and shows a debt as negative", () => {
    const html = render();
    // The ≈ marker (U+2248) + its label sit on the derived investment rows.
    expect(html).toMatch(/≈/u);
    expect(html).toContain("Valor calculado");
    // A liability renders with a leading minus (U+2212 or hyphen; Intl uses NBSP).
    expect(html).toMatch(/[−-]\s?120\.000/u);
  });

  test("derived badge hover carries the relative price-refresh date + source (#303)", () => {
    const html = renderToStaticMarkup(
      <BalanceBoard
        currentUrl="/patrimonio"
        groups={[
          group("market", "Mercado", 5_000_00, [
            assetRow("a_priced", "Fondo Cotizado", 5_000_00, {
              derived: true,
              priceFetchedAt: "2026-06-08T08:00:00.000Z",
              priceSource: "yahoo",
            }),
          ]),
        ]}
        isHousehold={false}
        nowIso="2026-06-10T12:00:00.000Z"
        privacyMode={false}
        publicIdByHolding={{ a_manual: "wl_hld_manual", a_priced: "wl_hld_priced" }}
        trash={emptyTrash}
        warnings={[]}
      />,
    );
    // The native title still leads with the existing "Valor calculado" text and
    // ALSO carries the relative refresh date + provider (one tooltip, no JS).
    expect(html).toContain(
      "Valor calculado (unidades × precio) · precio de hace 2 días, vía Yahoo",
    );
  });

  test("a non-priced derived holding keeps the bare 'Valor calculado' hover (#303)", () => {
    const html = renderToStaticMarkup(
      <BalanceBoard
        currentUrl="/patrimonio"
        groups={[
          group("market", "Mercado", 5_000_00, [
            assetRow("a_manual", "Fondo Manual", 5_000_00, { derived: true }),
          ]),
        ]}
        isHousehold={false}
        nowIso="2026-06-10T12:00:00.000Z"
        privacyMode={false}
        publicIdByHolding={{ a_manual: "wl_hld_manual", a_priced: "wl_hld_priced" }}
        trash={emptyTrash}
        warnings={[]}
      />,
    );
    expect(html).toContain('title="Valor calculado (unidades × precio)"');
    expect(html).not.toContain("vía");
  });

  test("shows ownership share only in household scope", () => {
    expect(render({ isHousehold: true })).toMatch(/60\s?%/u);
    expect(render({ isHousehold: false })).not.toMatch(/60\s?%/u);
  });

  test("masks money values when privacy mode is on", () => {
    const html = render({ privacyMode: true });
    expect(html).toContain("**.***");
    expect(html).not.toContain("330.000");
    expect(html).not.toContain("210.000");
  });

  test("surfaces an overrideable warning with the acknowledge action", () => {
    const warnings: DomainWarning[] = [
      {
        code: "zero_value",
        severity: "overrideable",
        entityType: "asset",
        entityId: "a_small",
        message: "Valor cero intencional",
      },
    ];
    const html = render({ warnings });
    expect(html).toContain("Valor cero intencional");
    expect(html).toContain("Es intencional");
    expect(html).toMatch(/⚠/u); // warning badge
  });

  test("renders the trash with its count and both kinds of items", () => {
    const html = render({
      trash: {
        assets: [{ id: "t_a", name: "Cuenta Vieja" }],
        liabilities: [{ id: "t_l", name: "Prestamo Saldado" }],
      },
    });
    expect(html).toContain("Papelera (2)");
    expect(html).toContain("Cuenta Vieja");
    expect(html).toContain("Prestamo Saldado");
  });

  test("a trashed row says how the holding left the book (#1549)", () => {
    const html = render({
      trash: {
        assets: [
          { id: "t_a", name: "Groupama", trashExit: "mis_entry" },
          { id: "t_b", name: "Cuenta Vieja" },
        ],
        liabilities: [],
      },
    });
    expect(html).toContain("error de registro");
    // A holding archived with nothing inside recorded no exit, and says nothing:
    // exactly one row carries the aside.
    expect(html.match(/balanceTrashExit/g)).toHaveLength(1);
  });

  test("renders an empty state when there are no holdings", () => {
    expect(render({ groups: [] })).toContain("Sin activos");
  });
});

describe("BalanceBoard — Libro mayor notation (canon §4/§5/§6)", () => {
  test("marks the Pasivos column with the debit rule and totals with the double rule", () => {
    const html = render();
    expect(html).toContain("balancePaneDebt debitCol");
    // Both pane totals and the reconciled net carry the double-underline primitive.
    expect(html).toContain("balancePaneTotal totalRule");
    expect(html).toContain("balanceReconValue totalRule");
  });

  test("bands alternate rows (papel rayado)", () => {
    // The Mercado section has two rows, so the second one bands.
    expect(render()).toContain("balanceRow band");
  });

  test("keeps debt figures in ink — red is reserved for movement (canon §6)", () => {
    const html = render();
    // No inline red anywhere on the board; the debt column speaks the debit hue.
    expect(html).not.toContain("var(--red)");
    expect(html).toContain("var(--debit-rule)");
  });
});

describe("BalanceBoard closed positions", () => {
  /** Two live rows plus fully-sold derived positions and a stored asset at 0. */
  function groupsWithClosed(): PortfolioGroup[] {
    return [
      group("market", "Mercado", 25_000_00, [
        assetRow("a_live", "Fondo Vivo", 25_000_00, { derived: true }),
        assetRow("a_sold_b", "Fondo Vendido B", 0, { derived: true }),
        assetRow("a_sold_a", "Fondo Vendido A", 0, { derived: true }),
        // A STORED asset at 0 is an anomaly (ZERO_VALUE_ASSET), not a closed
        // position — it must stay in the live list where its warning points.
        assetRow("a_zero_manual", "Cuenta A Cero", 0),
      ]),
    ];
  }

  const operated = new Set(["a_live", "a_sold_a", "a_sold_b", "a_zero_manual"]);

  test("folds fully-sold derived positions behind a counter, out of the live rows", () => {
    const html = render({ groups: groupsWithClosed(), operatedAssetIds: operated });

    expect(html).toContain("Posiciones cerradas (2)");
    // The fold is a details AFTER the live rows: the sold funds render inside
    // it (alphabetical), still as first-class rows with their ficha link.
    const foldAt = html.indexOf("balanceClosed");
    expect(foldAt).toBeGreaterThan(html.indexOf("Fondo Vivo"));
    expect(html.indexOf("Fondo Vendido A")).toBeGreaterThan(foldAt);
    expect(html.indexOf("Fondo Vendido A")).toBeLessThan(html.indexOf("Fondo Vendido B"));
    expect(html).toContain('href="/patrimonio/wl_hld_a_sold_a/editar"');
    // The stored zero-value asset is NOT folded away.
    expect(html.indexOf("Cuenta A Cero")).toBeLessThan(foldAt);
  });

  test("a just-created investment (derived 0, NO operations) stays in the live list", () => {
    // The regression the E2E suite caught: a brand-new investment also reads 0
    // until its first buy — folding it away would make it look lost.
    const html = render({
      groups: [
        group("market", "Mercado", 0, [
          assetRow("a_new", "Fondo Recien Creado", 0, { derived: true }),
        ]),
      ],
      operatedAssetIds: new Set(),
    });

    expect(html).not.toContain("Posiciones cerradas");
    const foldAt = html.indexOf("balanceClosed");
    expect(foldAt).toBe(-1);
    expect(html).toContain("Fondo Recien Creado");
  });

  test("no fold when nothing is fully sold", () => {
    expect(render({ operatedAssetIds: operated })).not.toContain("Posiciones cerradas");
  });

  test("a portfolio that is ONLY closed positions still shows the fold, not the empty state", () => {
    const html = render({
      groups: [
        group("market", "Mercado", 0, [
          assetRow("a_sold", "Fondo Vendido", 0, { derived: true }),
        ]),
      ],
      operatedAssetIds: new Set(["a_sold"]),
    });

    expect(html).toContain("Posiciones cerradas (1)");
    expect(html).not.toContain("Sin activos.");
  });
});

// ── managed portfolio groups (#1548) ────────────────────────────────────────

/** A block over two members plus the container's cash — Jorge's Metal, small. */
function metalGroup(): PortfolioGroup {
  const members = [
    assetRow("a_metal_us", "iShares US Equity Index S", 589_98, { derived: true }),
    assetRow("a_metal_pac", "Fidelity MSCI Pacific", 39_77, { derived: true }),
    assetRow("a_metal_cash", "Efectivo de la cartera", 7_34, { tier: "cash" }),
  ];
  const total = members.reduce((acc, m) => acc + signedMinor(m), 0);
  return {
    holdings: members,
    key: "market",
    label: "Mercado",
    totalMinor: { amountMinor: total, currency: EUR },
    units: [
      {
        instrument: "fund",
        key: "mp_metal",
        kind: "portfolio",
        members,
        portfolio: {
          holdingIds: members.map((m) => m.id),
          id: "mp_metal",
          name: "Cartera Indexada Metal",
          provider: "MyInvestor",
        },
        signedMinor: total,
        tier: "market",
      },
    ],
  };
}

const metalPublicIds = { mp_metal: "wl_prt_metal1" };

describe("managed portfolio group (#1548)", () => {
  test("collapsed, the header is the summand and no member is listed", () => {
    const html = render({
      groups: [metalGroup()],
      publicIdByPortfolio: metalPublicIds,
    });
    expect(html).toContain("Cartera Indexada Metal");
    expect(html).not.toContain("iShares US Equity Index S");
    // 589,98 + 39,77 + 7,34 = 637,09 → the board rounds figures to whole euros
    expect(html).toContain("637\u00a0€");
  });

  test("the pane total is the same collapsed and expanded", () => {
    const collapsed = render({
      groups: [metalGroup()],
      publicIdByPortfolio: metalPublicIds,
    });
    const expanded = render({
      groups: [metalGroup()],
      initialOpenPortfolios: new Set(["wl_prt_metal1"]),
      publicIdByPortfolio: metalPublicIds,
    });
    const total = (html: string) =>
      html.match(/balancePaneTotal totalRule">([^<]+)</)?.[1];
    expect(total(collapsed)).toBe(total(expanded));
    expect(total(collapsed)).toContain("637\u00a0€");
  });

  test("expanded, the members show with their weights", () => {
    const html = render({
      groups: [metalGroup()],
      initialOpenPortfolios: new Set(["wl_prt_metal1"]),
      publicIdByPortfolio: metalPublicIds,
    });
    expect(html).toContain("iShares US Equity Index S");
    expect(html).toContain("Efectivo de la cartera");
    // 589,98 / 637,09 = 92,6 %
    expect(html).toContain("92,6 %");
  });

  test("the name links to the ficha and the chip says what the row is", () => {
    const html = render({
      groups: [metalGroup()],
      publicIdByPortfolio: metalPublicIds,
    });
    expect(html).toContain('href="/patrimonio/carteras/wl_prt_metal1"');
    expect(html).toContain("cartera</span>");
  });

  test("members link to their own ficha by public id, never the internal one", () => {
    const html = render({
      groups: [metalGroup()],
      initialOpenPortfolios: new Set(["wl_prt_metal1"]),
      publicIdByPortfolio: metalPublicIds,
    });
    expect(html).toContain("wl_hld_a_metal_us");
    expect(html).not.toContain('href="/patrimonio/a_metal_us"');
  });

  test("a portfolio with no registry row still renders, unlinked and inert", () => {
    const html = render({ groups: [metalGroup()], publicIdByPortfolio: {} });
    expect(html).toContain("Cartera Indexada Metal");
    expect(html).not.toContain("/patrimonio/carteras/");
    expect(html).toContain("disabled");
  });
});
